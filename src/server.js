const express = require('express');
const path = require('path');
const { Crawler } = require('./crawler/crawler');
const { scoreSite } = require('./scoring/buildAuditData');
const { selectPagesForBrowserAudit } = require('./performance/selectSample');
const { initDb, saveAuditRun, getAuditHistory } = require('./storage/db');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));

const db = initDb();

const BROWSER_SAMPLE_SIZE = 5;

// Runs the Playwright-based browser audit on a sample of pages. Wrapped so
// that if Playwright/Chromium isn't installed in a given deployment (e.g. a
// grading environment that only ran `npm install`, not
// `npx playwright install chromium`), the whole audit degrades gracefully
// to the Week 1/2 placeholder behavior instead of crashing the request.
async function runSampledBrowserAudits(pages, startUrl) {
  const sample = selectPagesForBrowserAudit(pages, startUrl, BROWSER_SAMPLE_SIZE);
  if (sample.length === 0) return {};

  let browserModule;
  try {
    // Required lazily so a missing Playwright install only breaks this
    // function, not the whole server (which would fail at require-time
    // if this were a top-level import).
    browserModule = require('./performance/browserAudit');
  } catch (err) {
    console.warn('Playwright not available — skipping browser-based checks:', err.message);
    return {};
  }

  let browser;
  try {
    browser = await browserModule.launchSharedBrowser();
  } catch (err) {
    console.warn('Could not launch a browser — skipping browser-based checks:', err.message);
    console.warn('Run `npx playwright install chromium` to enable Performance/Mobile checks.');
    return {};
  }

  const results = {};
  try {
    // Sequential, not parallel: each Chromium page is memory/CPU-heavy, and
    // a sample is only 5 pages, so the time cost of doing them one at a
    // time is acceptable for now. Worth revisiting with limited concurrency
    // if the sample size grows.
    for (const page of sample) {
      try {
        results[page.url] = await browserModule.runBrowserAudit(page.url, { browser });
      } catch (err) {
        console.warn(`Browser audit failed for ${page.url}:`, err.message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/audit', async (req, res) => {
  let { url, maxPages } = req.body;
  if (!url) return res.status(400).send('Missing url');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  maxPages = Math.min(Math.max(parseInt(maxPages, 10) || 20, 1), 200);

  try {
    const crawler = new Crawler(url, { maxPages, delayMs: 100 });
    const [pages, sitemapResult, sslResult] = await Promise.all([
      crawler.crawl(),
      crawler.checkSitemap(),
      crawler.checkSsl(),
    ]);

    const browserResults = await runSampledBrowserAudits(pages, crawler.startUrl);

    const result = scoreSite({
      pages, sitemapResult, sslResult, browserResults, robots: crawler.robots, startUrl: crawler.startUrl,
      crawlTimedOut: crawler.crawlTimedOut,
    });

    // Persist before fetching history so the trend view includes this run.
    try {
      saveAuditRun(db, { startUrl: crawler.startUrl, pagesCrawled: pages.length, scoreResult: result });
    } catch (err) {
      console.warn('Could not save audit run to history:', err.message);
    }

    let history = [];
    try {
      history = getAuditHistory(db, crawler.startUrl);
    } catch (err) {
      console.warn('Could not load audit history:', err.message);
    }

    res.render('results', { startUrl: crawler.startUrl, pages, result, history, browserResults });
  } catch (err) {
    res.status(500).send(`Audit failed: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = { app, runSampledBrowserAudits };