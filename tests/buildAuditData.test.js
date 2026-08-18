const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { scoreSite } = require('../src/scoring/buildAuditData');

function fakePage(overrides = {}) {
  return {
    url: 'https://site.com/page',
    statusCode: 200,
    title: 'A decent length title for this page',
    metaDescription: 'A meta description that sits comfortably inside the one hundred twenty to one sixty character target window for search snippets.',
    h1Count: 1,
    h1Text: 'A main heading with a comfortably ideal character length',
    canonical: 'https://site.com/page',
    metaRobots: null,
    hasViewport: true,
    imageCount: 4,
    imagesMissingAlt: 0,
    structuredDataRaw: ['{"@type": "WebPage", "name": "Test"}'],
    brokenHeadingHierarchy: false,
    hstsPresent: true,
    securityHeadersPresent: true,
    redirectHops: 0,
    redirectLoopDetected: false,
    mixedContent: false,
    ...overrides,
  };
}

describe('scoreSite', () => {
  test('a clean single-page site scores well (not necessarily 100 — placeholders exist)', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.ok(result.final >= 90, `expected a high score for a clean site, got ${result.final}`);
  });

  test('missing robots.txt and sitemap both penalize crawlability', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: false },
      robots: null,
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.crawlability.points, 30 - 5 - 3);
  });

  test('homepage noindex is detected and critically penalized', () => {
    const pages = [fakePage({ url: 'https://site.com', metaRobots: 'noindex, follow' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.crawlability.points, 30 - 15);
  });

  test('Disallow: / for wildcard agent is detected as critical', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: (url, agent) => agent !== '*' },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.crawlability.points, 30 - 25);
  });

  test('404 and 5xx pages are counted correctly into the technical category', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }),
      { url: 'https://site.com/missing', statusCode: 404, title: undefined },
      { url: 'https://site.com/missing2', statusCode: 404, title: undefined },
      { url: 'https://site.com/broken', statusCode: 500, title: undefined },
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    // 2x 404 -> floor(2/5)=0 penalty; 1x 5xx -> 1*2=2 penalty
    assert.equal(result.categories.technical.points, 25 - 2);
  });

  test('on-page score is averaged across pages, not just the first one', () => {
    const goodPage = fakePage({ url: 'https://site.com' });
    const badPage = fakePage({ url: 'https://site.com/bad', title: null, metaDescription: null });
    const result = scoreSite({
      pages: [goodPage, badPage],
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    // good page: 15/15. bad page: missing title (-2) and description (-2) = 11/15.
    // average = (15 + 11) / 2 = 13
    assert.equal(result.categories.onPage.points, 13);
  });

  test('performance category defaults to a neutral placeholder, not a penalty', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.performance.points, 20);
    assert.ok(result.notYetMeasured.includes('lcp'));
  });

  test('duplicate titles across pages are flagged as duplicate, not missing', () => {
    const pages = [
      fakePage({ url: 'https://site.com/a', title: 'Same Title Everywhere', metaDescription: 'A first unique meta description that is comfortably within the seventy to one hundred sixty character target range for search snippets.' }),
      fakePage({ url: 'https://site.com/b', title: 'Same Title Everywhere', metaDescription: 'A second, different meta description that is also comfortably within the seventy to one hundred sixty character target range here.' }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com/a',
    });
    // 'Same Title Everywhere' is duplicated across both pages. Short titles
    // are no longer penalized; only titles over 70 characters are.
    assert.equal(result.categories.onPage.points, 14);
    const entry = result.categoryDetails.onPage.find((i) => i.code === 'title_duplicate');
    assert.deepEqual(entry.duplicateGroups, [{
      value: 'Same Title Everywhere',
      pages: ['https://site.com/a', 'https://site.com/b'],
    }]);
  });

  test('query-string variants are treated as the same logical page for duplicate checks', () => {
    const pages = [
      fakePage({ url: 'https://site.com/search?flightSearch=A', title: 'Search Results', metaDescription: 'Same search page description.' }),
      fakePage({ url: 'https://site.com/search?flightSearch=B', title: 'Search Results', metaDescription: 'Same search page description.' }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com/search?flightSearch=A',
    });
    assert.equal(result.categoryDetails.onPage.some((i) => i.code === 'title_duplicate'), false);
    assert.equal(result.categoryDetails.onPage.some((i) => i.code === 'description_duplicate'), false);
  });

  test('missing HSTS and security headers on the homepage penalize technical score', () => {
    const pages = [fakePage({ url: 'https://site.com', hstsPresent: false, securityHeadersPresent: false })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.technical.points, 25 - 2 - 3);
  });

  test('a redirect chain (>1 hop) on any page is counted', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }),
      fakePage({ url: 'https://site.com/old', redirectHops: 2 }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.technical.points, 25 - 3); // 1 chained URL * 3 pts
  });

  test('a detected redirect loop is a critical -10', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }),
      fakePage({ url: 'https://site.com/loop', redirectLoopDetected: true }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.technical.points, 25 - 10);
  });

  test('mixed content on any page is a -5', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }),
      fakePage({ url: 'https://site.com/insecure', mixedContent: true }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.technical.points, 25 - 5);
  });

  test('an invalid SSL certificate (actually checked) is a critical -15', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      sslResult: { checked: true, valid: false },
    });
    assert.equal(result.categories.technical.points, 25 - 15);
  });

  test('an SSL check that could not run (checked: false) does not penalize', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      sslResult: { checked: false, valid: false, reason: 'timeout' },
    });
    assert.equal(result.categories.technical.points, 25); // not penalized — not confirmed invalid
  });

  test('no sslResult at all (SSL check not run) does not penalize', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    assert.equal(result.categories.technical.points, 25);
  });
});

describe('scoreSite with browser (Playwright) results', () => {
  function goodBrowserResult(overrides = {}) {
    return {
      lcp: 1.2, inp: 80, cls: 0.02, ttfb: 150,
      viewportPresent: true, mobileFriendly: true,
      touchableElementsTooSmall: false, fontTooSmall: false,
      lineHeightTooTight: false, intrusivePopups: false,
      ...overrides,
    };
  }

  test('with no browserResults at all, performance stays the flat 20/20 placeholder', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({ pages, sitemapResult: { found: true }, robots: { isAllowed: () => true }, startUrl: 'https://site.com' });
    assert.equal(result.categories.performance.points, 20);
    assert.ok(result.notYetMeasured.includes('lcp'));
  });

  test('a page with a good browser result scores full performance points', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      browserResults: { 'https://site.com': goodBrowserResult() },
    });
    assert.equal(result.categories.performance.points, 20);
    assert.ok(!result.notYetMeasured.includes('lcp')); // now actually measured
  });

  test('a slow LCP from a browser result penalizes performance', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      browserResults: { 'https://site.com': goodBrowserResult({ lcp: 5 }) }, // >4s
    });
    assert.equal(result.categories.performance.points, 20 - 5);
  });

  test('performance is averaged only over sampled pages, not all crawled pages', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }), // sampled, good
      fakePage({ url: 'https://site.com/not-sampled' }), // no browser result at all
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      browserResults: { 'https://site.com': goodBrowserResult() },
    });
    // only one page had a browser result, and it was clean -> full points,
    // NOT averaged down by the unsampled page (which has no data at all)
    assert.equal(result.categories.performance.points, 20);
  });

  test('a browser-detected mobile-unfriendly page penalizes mobile score', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      browserResults: { 'https://site.com': goodBrowserResult({ mobileFriendly: false }) },
    });
    assert.equal(result.categories.mobile.points, 10 - 4);
  });

  test('pages without a browser result still get the static viewport-only mobile check', () => {
    const pages = [fakePage({ url: 'https://site.com', hasViewport: false })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
      // no browserResults at all
    });
    assert.equal(result.categories.mobile.points, 10 - 3); // missing viewport, from the static check
  });
});

describe('categoryDetails (drill-down data)', () => {
  test('an on-page issue shared by multiple pages is grouped into one entry with both page URLs', () => {
    const pages = [
      fakePage({ url: 'https://site.com/a', title: null }),
      fakePage({ url: 'https://site.com/b', title: null }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com/a',
    });
    const entry = result.categoryDetails.onPage.find((i) => i.code === 'title_missing');
    assert.ok(entry, 'expected a title_missing entry');
    assert.deepEqual(entry.pages.sort(), ['https://site.com/a', 'https://site.com/b']);
  });

  test('an on-page issue affecting only one page lists only that page', () => {
    const pages = [
      fakePage({ url: 'https://site.com/a' }),
      fakePage({ url: 'https://site.com/b', title: null }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com/a',
    });
    const entry = result.categoryDetails.onPage.find((i) => i.code === 'title_missing');
    assert.deepEqual(entry.pages, ['https://site.com/b']);
  });

  test('a page-specific crawlability issue (missing canonical) lists the affected pages', () => {
    const pages = [
      fakePage({ url: 'https://site.com/a', canonical: null }),
      fakePage({ url: 'https://site.com/b' }),
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com/a',
    });
    const entry = result.categoryDetails.crawlability.find((i) => i.code === 'missing_canonical');
    assert.deepEqual(entry.pages, ['https://site.com/a']);
  });

  test('a genuinely site-wide crawlability issue (no sitemap) has an empty pages list, not a crash', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: false },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    const entry = result.categoryDetails.crawlability.find((i) => i.code === 'no_sitemap');
    assert.ok(entry);
    assert.deepEqual(entry.pages, []);
  });

  test('a technical issue (404s) lists exactly the broken pages', () => {
    const pages = [
      fakePage({ url: 'https://site.com' }),
      { url: 'https://site.com/missing1', statusCode: 404, title: undefined },
      { url: 'https://site.com/missing2', statusCode: 404, title: undefined },
      { url: 'https://site.com/missing3', statusCode: 404, title: undefined },
      { url: 'https://site.com/missing4', statusCode: 404, title: undefined },
      { url: 'https://site.com/missing5', statusCode: 404, title: undefined },
    ];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    const entry = result.categoryDetails.technical.find((i) => i.code === 'errors_404');
    assert.ok(entry, 'expected an errors_404 entry (5 404s should trigger the >=5 penalty threshold)');
    assert.deepEqual(
      entry.pages.sort(),
      ['https://site.com/missing1', 'https://site.com/missing2', 'https://site.com/missing3', 'https://site.com/missing4', 'https://site.com/missing5'],
    );
  });

  test('categoryDetails has an (empty) array for every category even when there are no issues at all', () => {
    const pages = [fakePage({ url: 'https://site.com' })];
    const result = scoreSite({
      pages,
      sitemapResult: { found: true },
      robots: { isAllowed: () => true },
      startUrl: 'https://site.com',
    });
    for (const key of ['crawlability', 'technical', 'performance', 'onPage', 'mobile']) {
      assert.ok(Array.isArray(result.categoryDetails[key]), `expected an array for ${key}`);
    }
  });
});
