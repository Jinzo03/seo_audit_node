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
    // 'Same Title Everywhere' is 22 chars (under the 30-char minimum) AND
    // duplicated across both pages -> -1 (length) -1 (duplicate) = 13 each.
    assert.equal(result.categories.onPage.points, 13);
  });
});
