const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { hasHsts, hasAnySecurityHeader } = require('../src/crawler/securityHeaders');
const { detectMixedContent } = require('../src/crawler/mixedContent');

function fakeHeaders(map) {
  return { get: (name) => map[name.toLowerCase()] || null };
}

describe('security headers', () => {
  test('hasHsts true when the header is present', () => {
    const headers = fakeHeaders({ 'strict-transport-security': 'max-age=31536000' });
    assert.equal(hasHsts(headers), true);
  });

  test('hasHsts false when absent', () => {
    const headers = fakeHeaders({});
    assert.equal(hasHsts(headers), false);
  });

  test('hasHsts false when headers object is missing entirely', () => {
    assert.equal(hasHsts(null), false);
    assert.equal(hasHsts(undefined), false);
  });

  test('hasAnySecurityHeader true if at least one common header is set', () => {
    const headers = fakeHeaders({ 'x-frame-options': 'DENY' });
    assert.equal(hasAnySecurityHeader(headers), true);
  });

  test('hasAnySecurityHeader false when none of the common headers are set', () => {
    const headers = fakeHeaders({ 'some-other-header': 'value' });
    assert.equal(hasAnySecurityHeader(headers), false);
  });
});

describe('mixed content detection', () => {
  test('detects an HTTP image on an HTTPS page', () => {
    const $ = cheerio.load('<html><body><img src="http://insecure.com/a.png"></body></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), true);
  });

  test('detects an HTTP script src', () => {
    const $ = cheerio.load('<html><head><script src="http://insecure.com/a.js"></script></head></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), true);
  });

  test('detects an HTTP stylesheet', () => {
    const $ = cheerio.load('<html><head><link rel="stylesheet" href="http://insecure.com/a.css"></head></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), true);
  });

  test('detects an HTTP iframe', () => {
    const $ = cheerio.load('<html><body><iframe src="http://insecure.com/embed"></iframe></body></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), true);
  });

  test('all-HTTPS resources report no mixed content', () => {
    const $ = cheerio.load('<html><body><img src="https://site.com/a.png"><script src="https://cdn.site.com/b.js"></script></body></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), false);
  });

  test('relative URLs are not flagged (they inherit the page scheme)', () => {
    const $ = cheerio.load('<html><body><img src="/images/a.png"></body></html>');
    assert.equal(detectMixedContent($, 'https://site.com/page'), false);
  });

  test('an HTTP page is not checked at all (mixed content only applies to HTTPS pages)', () => {
    const $ = cheerio.load('<html><body><img src="http://insecure.com/a.png"></body></html>');
    assert.equal(detectMixedContent($, 'http://site.com/page'), false);
  });
});
