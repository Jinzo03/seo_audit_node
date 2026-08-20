require('./config/loadEnv').loadEnv();

const express = require('express');
const path = require('path');
const { Crawler } = require('./crawler/crawler');
const { scoreSite } = require('./scoring/buildAuditData');
const { selectPagesForBrowserAudit } = require('./performance/selectSample');
const {
  initDb,
  saveAuditRun,
  getAuditHistory,
  getAuditById,
  listAuditDomains,
  getDomainStats,
} = require('./storage/db');
const { runCitationAudit } = require('./geo/citations');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));

const db = initDb();

const BROWSER_SAMPLE_SIZE = 10;
const auditJobs = new Map();
let nextJobId = 1;

// Runs browser-only checks on a small sample. If Chromium is unavailable,
// the report still completes with neutral placeholders for those metrics.
async function runSampledBrowserAudits(pages, startUrl) {
  const sample = selectPagesForBrowserAudit(pages, startUrl, BROWSER_SAMPLE_SIZE);
  if (sample.length === 0) return {};

  let browserModule;
  try {
    browserModule = require('./performance/browserAudit');
  } catch (err) {
    console.warn('Playwright not available - skipping browser-based checks:', err.message);
    return {};
  }

  let browser;
  try {
    browser = await browserModule.launchSharedBrowser();
  } catch (err) {
    console.warn('Could not launch a browser - skipping browser-based checks:', err.message);
    console.warn('Run `npx playwright install chromium` to enable Performance/Mobile checks.');
    return {};
  }

  const results = {};
  try {
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

function publicJobState(job) {
  return {
    id: job.id,
    status: job.status,
    url: job.url,
    maxPages: job.maxPages,
    pagesCrawled: job.pagesCrawled,
    reportUrl: job.reportUrl,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function createAuditJob(input) {
  const now = Date.now();
  const job = {
    id: String(nextJobId),
    status: 'queued',
    url: input.url,
    maxPages: input.maxPages,
    geoRequested: input.geoRequested,
    geoQueries: input.geoQueries,
    pagesCrawled: 0,
    reportUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  nextJobId += 1;
  auditJobs.set(job.id, job);
  setImmediate(() => runAuditJob(job));
  return job;
}

async function runAuditJob(job) {
  job.status = 'running';
  job.updatedAt = Date.now();

  try {
    const crawler = new Crawler(job.url, { maxPages: job.maxPages, delayMs: 100 });
    const pages = await crawler.crawl();
    job.pagesCrawled = pages.length;
    job.updatedAt = Date.now();

    const [sitemapResult, sslResult] = await Promise.all([
      crawler.checkSitemap(),
      crawler.checkSsl(),
    ]);

    const browserResults = await runSampledBrowserAudits(pages, crawler.startUrl);
    const geoCitations = await runCitationAudit({
      requested: job.geoRequested,
      userQueries: job.geoQueries,
      pages,
      domain: crawler.domain,
      options: { maxTotal: 5, maxAuto: 3 },
    });

    const result = scoreSite({
      pages,
      sitemapResult,
      sslResult,
      browserResults,
      robots: crawler.robots,
      startUrl: crawler.startUrl,
      crawlTimedOut: crawler.crawlTimedOut,
    });

    const saved = saveAuditRun(db, {
      startUrl: crawler.startUrl,
      pagesCrawled: pages.length,
      scoreResult: result,
      browserResults,
      geoCitations,
    });

    job.status = 'completed';
    job.pagesCrawled = pages.length;
    job.reportUrl = `/report/${saved.id}`;
    job.updatedAt = Date.now();
  } catch (err) {
    job.status = 'failed';
    job.error = `Audit failed: ${err.message}`;
    job.updatedAt = Date.now();
    console.warn(`Audit job ${job.id} failed:`, err.message);
  }
}

app.get('/', (req, res) => {
  let domains = [];
  try {
    domains = listAuditDomains(db);
  } catch (err) {
    console.warn('Could not load audit domains:', err.message);
  }

  const activeJobs = Array.from(auditJobs.values())
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .map(publicJobState);

  res.render('index', {
    domains,
    activeJobs,
    activeJobsJson: JSON.stringify(activeJobs).replace(/</g, '\\u003c'),
  });
});

app.post('/audit', (req, res) => {
  let { url, maxPages } = req.body;
  if (!url) return res.status(400).send('Missing url');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  maxPages = Math.min(Math.max(parseInt(maxPages, 10) || 20, 1), 5000);
  const geoRequested = req.body.runGeo === 'on';
  const geoQueries = String(req.body.geoQueries || '')
    .split(/\r?\n/)
    .map((q) => q.trim())
    .filter(Boolean);

  const job = createAuditJob({ url, maxPages, geoRequested, geoQueries });
  if (req.get('Accept') && req.get('Accept').includes('application/json')) {
    return res.status(202).json({ jobId: job.id, statusUrl: `/audit/jobs/${job.id}` });
  }

  res.status(202).send(`Audit started. Job id: ${job.id}`);
});

app.get('/audit/jobs/:id', (req, res) => {
  const job = auditJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Audit job not found' });
  res.json(publicJobState(job));
});

app.get('/audit/domains/:domain', (req, res) => {
  const stats = getDomainStats(db, req.params.domain);
  if (!stats) return res.status(404).json({ error: 'Audit domain not found' });
  res.json(stats);
});

app.get('/report/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).send('Invalid report id');

  const audit = getAuditById(db, id);
  if (!audit) return res.status(404).send('Audit not found - it may have been run on a different server instance.');

  let history = [];
  try {
    history = getAuditHistory(db, audit.start_url);
  } catch (err) {
    console.warn('Could not load audit history:', err.message);
  }

  res.render('results', {
    startUrl: audit.start_url,
    pagesCrawled: audit.pages_crawled,
    result: audit.result,
    history,
    browserResults: audit.browserResults,
    geoCitations: audit.geoCitations,
    auditId: id,
  });
});

app.get('/report/:id/category/:categoryKey', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { categoryKey } = req.params;
  const validKeys = ['crawlability', 'technical', 'performance', 'onPage', 'mobile'];

  if (!Number.isInteger(id) || !validKeys.includes(categoryKey)) {
    return res.status(400).send('Invalid report or category');
  }

  const audit = getAuditById(db, id);
  if (!audit) return res.status(404).send('Audit not found - it may have been run on a different server instance.');

  const items = audit.result.categoryDetails[categoryKey] || [];
  res.render('category', { audit, auditId: id, categoryKey, items, validKeys });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = {
  app,
  runSampledBrowserAudits,
  auditJobs,
  createAuditJob,
};
