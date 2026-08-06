const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { normalizeLink } = require('../src/crawler/normalizeLink');
const extract = require('../src/crawler/extract');
const { Crawler } = require('../src/crawler/crawler');
const { parseSitemapXml } = require('../src/crawler/sitemap');
const { isAllowed: robotsIsAllowed } = require('../src/crawler/robots');
const robotsParser = require('robots-parser');

// ---------------------------------------------------------------------
// Link normalization
// ---------------------------------------------------------------------
describe('normalizeLink', () => {
  test('resolves an absolute path against the base URL', () => {
    assert.equal(normalizeLink('https://site.com/blog/post', '/about'), 'https://site.com/about');
  });

  test('resolves a relative parent path correctly', () => {
    assert.equal(normalizeLink('https://site.com/blog/post', '../contact'), 'https://site.com/contact');
  });

  test('leaves an already-absolute URL unchanged', () => {
    assert.equal(normalizeLink('https://site.com/', 'https://other.com/page'), 'https://other.com/page');
  });

  test('strips the fragment', () => {
    assert.equal(normalizeLink('https://site.com/', '/page#section'), 'https://site.com/page');
  });

  test('rejects mailto: links', () => {
    assert.equal(normalizeLink('https://site.com/', 'mailto:test@site.com'), null);
  });

  test('rejects javascript: links', () => {
    assert.equal(normalizeLink('https://site.com/', 'javascript:void(0)'), null);
  });

  test('rejects tel: links', () => {
    assert.equal(normalizeLink('https://site.com/', 'tel:+21612345678'), null);
  });

  test('rejects a pure fragment', () => {
    assert.equal(normalizeLink('https://site.com/page', '#top'), null);
  });

  test('rejects an empty href', () => {
    assert.equal(normalizeLink('https://site.com/', ''), null);
  });
});

// ---------------------------------------------------------------------
// Extraction accuracy
// ---------------------------------------------------------------------
describe('extraction', () => {
  const html = `
    <html><head>
      <title>  My Page Title  </title>
      <meta name="description" content="  A short description.  ">
      <link rel="canonical" href="https://site.com/canonical/">
      <meta name="viewport" content="width=device-width">
      <meta name="robots" content="noindex, nofollow">
      <script type="application/ld+json">{"@type": "Article", "name": "Test"}</script>
    </head><body>
      <h1>Main heading</h1>
      <img src="a.png" alt="An image">
      <img src="b.png">
      <p>Some visible text content here for word counting purposes.</p>
      <a href="/about">About</a>
      <a href="https://external.com/page">External</a>
    </body></html>
  `;
  const $ = cheerio.load(html);
  const $empty = cheerio.load('<html><head></head><body></body></html>');

  test('extracts and trims the title', () => {
    assert.equal(extract.extractTitle($), 'My Page Title');
  });

  test('missing title returns null', () => {
    assert.equal(extract.extractTitle($empty), null);
  });

  test('extracts and trims the meta description', () => {
    assert.equal(extract.extractMetaDescription($), 'A short description.');
  });

  test('extracts H1 count and text', () => {
    const h1 = extract.extractH1($);
    assert.equal(h1.count, 1);
    assert.equal(h1.text, 'Main heading');
  });

  test('missing H1 returns zero and null', () => {
    const h1 = extract.extractH1($empty);
    assert.equal(h1.count, 0);
    assert.equal(h1.text, null);
  });

  test('extracts the canonical tag', () => {
    assert.equal(extract.extractCanonical($), 'https://site.com/canonical/');
  });

  test('extracts meta robots', () => {
    assert.equal(extract.extractMetaRobots($), 'noindex, nofollow');
  });

  test('detects viewport tag presence', () => {
    assert.equal(extract.extractViewport($), true);
    assert.equal(extract.extractViewport($empty), false);
  });

  test('counts images and missing alt text', () => {
    const images = extract.extractImages($);
    assert.equal(images.count, 2);
    assert.equal(images.missingAlt, 1);
  });

  test('word count', () => {
    assert.equal(extract.wordCount('one two three'), 3);
    assert.equal(extract.wordCount(''), 0);
  });

  test('content hash is deterministic and distinguishes different text', () => {
    const h1 = extract.contentHash('same text');
    const h2 = extract.contentHash('same text');
    const h3 = extract.contentHash('different text');
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
  });

  test('content hash of empty text is null', () => {
    assert.equal(extract.contentHash(''), null);
  });

  test('extracts one structured data block', () => {
    const blocks = extract.extractStructuredData($);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /Article/);
  });

  test('extracts and normalizes links found on the page', () => {
    const links = extract.extractLinks($, 'https://site.com/current-page');
    assert.ok(links.includes('https://site.com/about'));
    assert.ok(links.includes('https://external.com/page'));
    assert.equal(links.length, 2);
  });

  test('flags broken heading hierarchy (H1 -> H3, no H2)', () => {
    const $broken = cheerio.load('<html><body><h1>Title</h1><h3>Skipped H2</h3></body></html>');
    const result = extract.checkHeadingHierarchy($broken);
    assert.equal(result.brokenHierarchy, true);
  });

  test('does not flag a correct heading hierarchy', () => {
    const $ok = cheerio.load('<html><body><h1>Title</h1><h2>Section</h2><h3>Sub</h3></body></html>');
    const result = extract.checkHeadingHierarchy($ok);
    assert.equal(result.brokenHierarchy, false);
  });
});

// ---------------------------------------------------------------------
// SPA / JS-rendered page detection
// ---------------------------------------------------------------------
describe('detectPossibleSpa', () => {
  test('flags a React-style empty root with almost no text', () => {
    const $ = cheerio.load('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    assert.equal(extract.detectPossibleSpa($, 0), true);
  });

  test('flags a Vue/Nuxt-style app root the same way', () => {
    const $ = cheerio.load('<html><body><div id="__nuxt"></div></body></html>');
    assert.equal(extract.detectPossibleSpa($, 5), true);
  });

  test('flags an Angular app via the ng-version attribute', () => {
    const $ = cheerio.load('<html><body><app-root ng-version="17.0.0"></app-root></body></html>');
    assert.equal(extract.detectPossibleSpa($, 0), true);
  });

  test('does not flag a normal content-rich page even if it happens to have a #root div', () => {
    const html = `<html><body><div id="root">${'word '.repeat(80)}</div></body></html>`;
    const $ = cheerio.load(html);
    assert.equal(extract.detectPossibleSpa($, 80), false);
  });

  test('does not flag an ordinary page with no SPA root markers', () => {
    const $ = cheerio.load('<html><body><p>Just a normal thin page.</p></body></html>');
    assert.equal(extract.detectPossibleSpa($, 5), false);
  });
});

// ---------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------
describe('duplicate detection', () => {
  test('first visit returns true', () => {
    const crawler = new Crawler('https://site.com');
    assert.equal(crawler.markVisited('https://site.com/page'), true);
  });

  test('repeat visit returns false', () => {
    const crawler = new Crawler('https://site.com');
    crawler.markVisited('https://site.com/page');
    assert.equal(crawler.markVisited('https://site.com/page'), false);
  });

  test('visited URLs are never re-enqueued', () => {
    const crawler = new Crawler('https://site.com');
    crawler.markVisited('https://site.com/page');
    assert.equal(crawler.shouldEnqueue('https://site.com/page'), false);
  });

  test('unvisited same-domain URL should enqueue', () => {
    const crawler = new Crawler('https://site.com');
    assert.equal(crawler.shouldEnqueue('https://site.com/new-page'), true);
  });

  test('off-site URL should not enqueue', () => {
    const crawler = new Crawler('https://site.com');
    assert.equal(crawler.shouldEnqueue('https://other-domain.com/page'), false);
  });

  test('visited set only grows with unique URLs', () => {
    const crawler = new Crawler('https://site.com');
    for (let i = 0; i < 5; i += 1) crawler.markVisited('https://site.com/same');
    crawler.markVisited('https://site.com/different');
    assert.equal(crawler.visited.size, 2);
  });
});

// ---------------------------------------------------------------------
// Robots.txt adherence
// ---------------------------------------------------------------------
describe('robots.txt adherence', () => {
  function crawlerWithRules(rulesText) {
    const crawler = new Crawler('https://site.com');
    crawler.robots = robotsParser('https://site.com/robots.txt', rulesText);
    crawler._robotsLoaded = true;
    return crawler;
  }

  test('disallowed path is blocked', () => {
    const crawler = crawlerWithRules('User-agent: *\nDisallow: /private/\n');
    assert.equal(crawler.isAllowed('https://site.com/private/page'), false);
  });

  test('allowed path passes', () => {
    const crawler = crawlerWithRules('User-agent: *\nDisallow: /private/\n');
    assert.equal(crawler.isAllowed('https://site.com/public/page'), true);
  });

  test('user-agent-specific disallow (bare bot name) is respected', () => {
    const crawler = crawlerWithRules('User-agent: SimpleSEOAuditBot\nDisallow: /no-bots/\nUser-agent: *\nAllow: /\n');
    assert.equal(crawler.isAllowed('https://site.com/no-bots/page'), false);
  });

  test('missing robots.txt allows everything', () => {
    const crawler = new Crawler('https://site.com');
    crawler.robots = null;
    assert.equal(crawler.isAllowed('https://site.com/anything'), true);
  });

  test('shouldEnqueue respects a disallow rule', () => {
    const crawler = crawlerWithRules('User-agent: *\nDisallow: /private/\n');
    assert.equal(crawler.shouldEnqueue('https://site.com/private/page'), false);
  });

  test('robots.js isAllowed treats undefined result as allowed', () => {
    // robots-parser can return undefined for ambiguous cases — must not be
    // treated as "blocked" by default.
    assert.equal(robotsIsAllowed(null, 'https://site.com/x', 'AnyBot'), true);
  });
});

// ---------------------------------------------------------------------
// Error handling: 404, 500, timeouts, connection drops
// ---------------------------------------------------------------------
describe('error handling', () => {
  test('404 is recorded as a valid response, not an error', async () => {
    const crawler = new Crawler('https://site.com');
    const fakeResp = {
      status: 404,
      headers: { get: () => 'text/html' },
      text: async () => '<html></html>',
    };
    const page = await crawler.processPage('https://site.com/missing', fakeResp, 42, null);
    assert.equal(page.statusCode, 404);
    assert.equal(page.error, null);
  });

  test('500 is recorded as a valid response, not an error', async () => {
    const crawler = new Crawler('https://site.com');
    const fakeResp = {
      status: 500,
      headers: { get: () => 'text/html' },
      text: async () => '<html></html>',
    };
    const page = await crawler.processPage('https://site.com/broken', fakeResp, 10, null);
    assert.equal(page.statusCode, 500);
    assert.equal(page.error, null);
  });

  test('connection drop produces null status and an error message', async () => {
    const crawler = new Crawler('https://site.com');
    const page = await crawler.processPage('https://site.com/down', null, 0, 'Connection refused');
    assert.equal(page.statusCode, null);
    assert.equal(page.error, 'Connection refused');
  });

  test('non-HTML content type skips extraction', async () => {
    const crawler = new Crawler('https://site.com');
    const fakeResp = {
      status: 200,
      headers: { get: () => 'application/pdf' },
      text: async () => '',
    };
    const page = await crawler.processPage('https://site.com/file.pdf', fakeResp, 20, null);
    assert.equal(page.statusCode, 200);
    assert.equal('title' in page, false);
  });

  test('fetchOne catches a timeout/abort error', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
    try {
      const { resp, error } = await crawler.fetchOne('https://site.com');
      assert.equal(resp, null);
      assert.match(error, /timeout/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fetchOne catches a connection error', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('fetch failed: connection refused'); };
    try {
      const { resp, error } = await crawler.fetchOne('https://site.com');
      assert.equal(resp, null);
      assert.match(error, /connection refused/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fetchOne returns the response on success', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    const fakeResp = { status: 200 };
    global.fetch = async () => fakeResp;
    try {
      const { resp, error } = await crawler.fetchOne('https://site.com');
      assert.equal(resp, fakeResp);
      assert.equal(error, null);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------
describe('rate limiting', () => {
  test('delay is applied after a successful request', async () => {
    const crawler = new Crawler('https://site.com', { delayMs: 50 });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 200 });
    const start = Date.now();
    try {
      await crawler.fetchOne('https://site.com');
    } finally {
      global.fetch = originalFetch;
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 50, `expected at least 50ms delay, got ${elapsed}ms`);
  });

  test('no delay configured means (almost) no extra wait', async () => {
    const crawler = new Crawler('https://site.com', { delayMs: 0 });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 200 });
    const start = Date.now();
    try {
      await crawler.fetchOne('https://site.com');
    } finally {
      global.fetch = originalFetch;
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 30, `expected negligible delay, got ${elapsed}ms`);
  });

  test('delay still applies after a failed request', async () => {
    const crawler = new Crawler('https://site.com', { delayMs: 40 });
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('boom'); };
    const start = Date.now();
    try {
      await crawler.fetchOne('https://site.com');
    } finally {
      global.fetch = originalFetch;
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `expected the delay even on failure, got ${elapsed}ms`);
  });

  test('concurrency is capped when fetching a batch', async () => {
    const crawler = new Crawler('https://site.com', { concurrency: 2, delayMs: 0 });
    let active = 0;
    let maxActive = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: 200 };
    };
    try {
      await crawler.fetchWithConcurrencyCap(['https://site.com/a', 'https://site.com/b', 'https://site.com/c', 'https://site.com/d']);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(maxActive, 2, `expected max 2 concurrent fetches, saw ${maxActive}`);
  });
});

// ---------------------------------------------------------------------
// Sitemap XML parsing
// ---------------------------------------------------------------------
describe('sitemap parsing', () => {
  test('parses a flat sitemap as non-index', () => {
    const xml = `<?xml version="1.0"?>
      <urlset><url><loc>https://site.com/a</loc></url><url><loc>https://site.com/b</loc></url></urlset>`;
    const { isIndex, urls } = parseSitemapXml(xml);
    assert.equal(isIndex, false);
    assert.deepEqual(urls, ['https://site.com/a', 'https://site.com/b']);
  });

  test('parses a single-URL sitemap without collapsing into an object', () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://site.com/only</loc></url></urlset>`;
    const { urls } = parseSitemapXml(xml);
    assert.deepEqual(urls, ['https://site.com/only']);
  });

  test('detects a sitemap index and its sub-sitemap URLs', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex><sitemap><loc>https://site.com/sitemap1.xml</loc></sitemap><sitemap><loc>https://site.com/sitemap2.xml</loc></sitemap></sitemapindex>`;
    const { isIndex, urls } = parseSitemapXml(xml);
    assert.equal(isIndex, true);
    assert.deepEqual(urls, ['https://site.com/sitemap1.xml', 'https://site.com/sitemap2.xml']);
  });

  test('throws on XML with no recognizable sitemap root', () => {
    assert.throws(() => parseSitemapXml('<somethingElse></somethingElse>'));
  });

  test('empty urlset returns no URLs', () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    const { isIndex, urls } = parseSitemapXml(xml);
    assert.equal(isIndex, false);
    assert.deepEqual(urls, []);
  });
});

// ---------------------------------------------------------------------
// Redirect chain / loop detection
// ---------------------------------------------------------------------
describe('redirect handling', () => {
  function mockFetchSequence(routes) {
    return async (url) => {
      const route = routes[url];
      if (!route) throw new Error(`Unexpected fetch to ${url}`);
      return {
        status: route.status,
        headers: { get: (name) => (name.toLowerCase() === 'location' ? route.location || null : null) },
      };
    };
  }

  test('a direct response with no redirect reports zero hops', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence({ 'https://site.com/page': { status: 200 } });
    try {
      const { redirectHops, redirectLoopDetected } = await crawler.fetchOne('https://site.com/page');
      assert.equal(redirectHops, 0);
      assert.equal(redirectLoopDetected, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a single redirect hop is counted correctly', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence({
      'https://site.com/old': { status: 301, location: 'https://site.com/new' },
      'https://site.com/new': { status: 200 },
    });
    try {
      const { resp, redirectHops, redirectLoopDetected } = await crawler.fetchOne('https://site.com/old');
      assert.equal(redirectHops, 1);
      assert.equal(redirectLoopDetected, false);
      assert.equal(resp.status, 200);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a multi-hop redirect chain is counted correctly', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence({
      'https://site.com/a': { status: 301, location: 'https://site.com/b' },
      'https://site.com/b': { status: 302, location: 'https://site.com/c' },
      'https://site.com/c': { status: 301, location: 'https://site.com/d' },
      'https://site.com/d': { status: 200 },
    });
    try {
      const { redirectHops, redirectLoopDetected } = await crawler.fetchOne('https://site.com/a');
      assert.equal(redirectHops, 3);
      assert.equal(redirectLoopDetected, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a redirect loop is detected instead of looping forever', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence({
      'https://site.com/x': { status: 301, location: 'https://site.com/y' },
      'https://site.com/y': { status: 301, location: 'https://site.com/x' },
    });
    try {
      const { redirectLoopDetected } = await crawler.fetchOne('https://site.com/x');
      assert.equal(redirectLoopDetected, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('an excessively long chain is capped by maxRedirects instead of followed indefinitely', async () => {
    const crawler = new Crawler('https://site.com', { maxRedirects: 3 });
    const originalFetch = global.fetch;
    const routes = {};
    for (let i = 0; i < 10; i += 1) {
      routes[`https://site.com/step${i}`] = { status: 301, location: `https://site.com/step${i + 1}` };
    }
    global.fetch = mockFetchSequence(routes);
    try {
      const { redirectHops } = await crawler.fetchOne('https://site.com/step0');
      assert.equal(redirectHops, 3); // stopped at the cap, not all 10
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a redirect with a missing Location header is treated as final rather than crashing', async () => {
    const crawler = new Crawler('https://site.com');
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 301, headers: { get: () => null } });
    try {
      const { resp, redirectHops } = await crawler.fetchOne('https://site.com/weird');
      assert.equal(redirectHops, 0);
      assert.equal(resp.status, 301);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------
// Overall crawl timeout (distinct from the per-request timeoutMs)
// ---------------------------------------------------------------------
describe('crawl-level timeout', () => {
  test('stops crawling once the overall deadline is reached, instead of running until maxPages', async () => {
    const crawler = new Crawler('https://site.com', { maxPages: 100, crawlTimeoutMs: 60, delayMs: 0 });
    const originalFetch = global.fetch;
    let counter = 0;
    global.fetch = async (url) => {
      counter += 1;
      const n = counter;
      await new Promise((resolve) => setTimeout(resolve, 25)); // each fetch takes 25ms
      return {
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
        text: async () => `<html><body><a href="https://site.com/p${n}-next">next</a></body></html>`,
      };
    };
    try {
      const results = await crawler.crawl();
      assert.ok(results.length < 100, `expected the crawl to stop early, got ${results.length} pages`);
      assert.equal(crawler.crawlTimedOut, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('does not set crawlTimedOut when the crawl finishes well within the deadline', async () => {
    const crawler = new Crawler('https://site.com', { maxPages: 2, crawlTimeoutMs: 60000, delayMs: 0 });
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => '<html><body>done</body></html>',
    });
    try {
      await crawler.crawl();
      assert.equal(crawler.crawlTimedOut, false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------
// Large page size guard
// ---------------------------------------------------------------------
describe('large page size guard', () => {
  test('pages over maxPageSizeBytes skip full extraction and are flagged', async () => {
    const crawler = new Crawler('https://site.com', { maxPageSizeBytes: 100 });
    const hugeHtml = `<html><head><title>Huge</title></head><body>${'x'.repeat(500)}</body></html>`;
    const fakeResp = {
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => hugeHtml,
    };
    const page = await crawler.processPage('https://site.com/huge', fakeResp, 10, null);
    assert.equal(page.pageTooLarge, true);
    assert.ok(page.pageSizeBytes > 100);
    assert.equal('title' in page, false); // extraction was skipped
  });

  test('pages under the size cap extract normally', async () => {
    const crawler = new Crawler('https://site.com', { maxPageSizeBytes: 100000 });
    const fakeResp = {
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => '<html><head><title>Normal page</title></head><body>Some content.</body></html>',
    };
    const page = await crawler.processPage('https://site.com/normal', fakeResp, 10, null);
    assert.equal(page.pageTooLarge, undefined);
    assert.equal(page.title, 'Normal page');
  });
});
