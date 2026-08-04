const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { selectPagesForBrowserAudit } = require('../src/performance/selectSample');

function page(url, overrides = {}) {
  return { url, title: `Title for ${url}`, statusCode: 200, ...overrides };
}

describe('selectPagesForBrowserAudit', () => {
  test('always includes the homepage', () => {
    const pages = [page('https://site.com/a'), page('https://site.com'), page('https://site.com/b')];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 5);
    assert.ok(sample.some((p) => p.url === 'https://site.com'));
  });

  test('returns everything if there are fewer eligible pages than the sample size', () => {
    const pages = [page('https://site.com'), page('https://site.com/a')];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 5);
    assert.equal(sample.length, 2);
  });

  test('caps the sample at sampleSize even with many eligible pages', () => {
    const pages = [page('https://site.com'), ...Array.from({ length: 20 }, (_, i) => page(`https://site.com/p${i}`))];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 5);
    assert.equal(sample.length, 5);
  });

  test('excludes broken pages (404/500) from the sample', () => {
    const pages = [
      page('https://site.com'),
      page('https://site.com/broken', { statusCode: 404, title: undefined }),
      page('https://site.com/ok'),
    ];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 5);
    assert.ok(!sample.some((p) => p.url === 'https://site.com/broken'));
  });

  test('excludes non-HTML pages (no title extracted) from the sample', () => {
    const pages = [
      page('https://site.com'),
      { url: 'https://site.com/file.pdf', statusCode: 200 }, // no title -> non-HTML
    ];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 5);
    assert.ok(!sample.some((p) => p.url === 'https://site.com/file.pdf'));
  });

  test('empty page list returns an empty sample rather than throwing', () => {
    assert.deepEqual(selectPagesForBrowserAudit([], 'https://site.com', 5), []);
  });

  test('sample never contains duplicate URLs', () => {
    const pages = [page('https://site.com'), page('https://site.com/a'), page('https://site.com/b')];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 3);
    const urls = sample.map((p) => p.url);
    assert.equal(new Set(urls).size, urls.length);
  });

  test('picks pages spread across the crawl order, not just the first few', () => {
    const pages = [page('https://site.com'), ...Array.from({ length: 10 }, (_, i) => page(`https://site.com/p${i}`))];
    const sample = selectPagesForBrowserAudit(pages, 'https://site.com', 3);
    const sampledIndexes = sample
      .filter((p) => p.url !== 'https://site.com')
      .map((p) => Number(p.url.replace('https://site.com/p', '')));
    // with 10 candidates and 2 non-homepage slots, expect roughly p0 and p5 (evenly spread)
    // rather than p0 and p1 (just the first two)
    assert.ok(Math.max(...sampledIndexes) - Math.min(...sampledIndexes) >= 4);
  });
});
