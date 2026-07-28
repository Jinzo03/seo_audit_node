const express = require('express');
const path = require('path');
const { Crawler } = require('./crawler/crawler');
const { scoreSite } = require('./scoring/buildAuditData');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));

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
    const [pages, sitemapResult] = await Promise.all([crawler.crawl(), crawler.checkSitemap()]);
    const result = scoreSite({ pages, sitemapResult, robots: crawler.robots, startUrl: crawler.startUrl });

    res.render('results', { startUrl: crawler.startUrl, pages, result });
  } catch (err) {
    res.status(500).send(`Audit failed: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = { app };
