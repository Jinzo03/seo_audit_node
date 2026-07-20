const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AuditScoring } = require('../src/scoring/auditScoring');

// ---------------------------------------------------------------------
// Crawlability
// ---------------------------------------------------------------------
describe('scoreCrawlability', () => {
  test('perfect site scores full 30 points', () => {
    const s = new AuditScoring({ robotsTxtPresent: true, sitemapPresent: true, pagesMissingCanonical: 0 });
    assert.equal(s.scoreCrawlability().points, 30);
  });

  test('homepage noindex is a critical -15', () => {
    const s = new AuditScoring({ robotsTxtPresent: true, sitemapPresent: true, homepageNoindex: true });
    const result = s.scoreCrawlability();
    assert.equal(result.points, 30 - 15);
    assert.equal(result.issues.find((i) => i.severity === 'CRITICAL').points, -15);
  });

  test('Disallow: / is critical -25, isolated from other crawlability penalties', () => {
    const s = new AuditScoring({ robotsTxtPresent: true, sitemapPresent: true, disallowAll: true });
    const result = s.scoreCrawlability();
    assert.equal(result.points, 30 - 25);
  });

  test('score never goes below zero even with stacked critical penalties', () => {
    const s = new AuditScoring({ homepageNoindex: true, disallowAll: true, hreflangMisconfigured: true });
    assert.equal(s.scoreCrawlability().points, 0);
  });
});

// ---------------------------------------------------------------------
// Technical
// ---------------------------------------------------------------------
describe('scoreTechnical', () => {
  test('404 penalty is capped at -8 regardless of how many 404s', () => {
    const s = new AuditScoring({ errors404Count: 500, hstsPresent: true, securityHeadersPresent: true });
    const result = s.scoreTechnical();
    assert.equal(result.points, 25 - 8);
  });

  test('404 penalty is 1 point per 5 pages, floored', () => {
    const s = new AuditScoring({ errors404Count: 12, hstsPresent: true, securityHeadersPresent: true }); // floor(12/5) = 2
    assert.equal(s.scoreTechnical().points, 25 - 2);
  });

  test('5xx penalty is capped at -10', () => {
    const s = new AuditScoring({ errors5xxCount: 100, hstsPresent: true, securityHeadersPresent: true });
    assert.equal(s.scoreTechnical().points, 25 - 10);
  });

  test('redirect chain penalty is capped at -6', () => {
    const s = new AuditScoring({ redirectChainsCount: 50, hstsPresent: true, securityHeadersPresent: true });
    assert.equal(s.scoreTechnical().points, 25 - 6);
  });

  test('SSL invalid is a critical -15', () => {
    const s = new AuditScoring({ sslInvalid: true, hstsPresent: true, securityHeadersPresent: true });
    const result = s.scoreTechnical();
    assert.equal(result.points, 25 - 15);
    assert.equal(result.issues[0].severity, 'CRITICAL');
  });

  test('perfect site scores full 25 points', () => {
    const s = new AuditScoring({ hstsPresent: true, securityHeadersPresent: true });
    assert.equal(s.scoreTechnical().points, 25);
  });
});

// ---------------------------------------------------------------------
// Performance — including the FID -> INP substitution
// ---------------------------------------------------------------------
describe('scorePerformance', () => {
  test('good Core Web Vitals score full points on that front', () => {
    const s = new AuditScoring({ lcp: 1.5, inp: 100, cls: 0.03, ttfb: 200, gzipEnabled: true, browserCacheEnabled: true });
    assert.equal(s.scorePerformance().points, 20);
  });

  test('LCP over 4s is -5', () => {
    const s = new AuditScoring({ lcp: 5, gzipEnabled: true, browserCacheEnabled: true });
    assert.equal(s.scorePerformance().points, 20 - 5);
  });

  test('LCP between 2.5 and 4s is -2', () => {
    const s = new AuditScoring({ lcp: 3, gzipEnabled: true, browserCacheEnabled: true });
    assert.equal(s.scorePerformance().points, 20 - 2);
  });

  test('INP is used over FID when both are present', () => {
    const s = new AuditScoring({ inp: 100, fid: 500, gzipEnabled: true, browserCacheEnabled: true }); // inp is fine, fid would fail
    const result = s.scorePerformance();
    assert.equal(result.points, 20); // no penalty — INP (100ms) is under the 200ms threshold
  });

  test('falls back to FID when INP is not provided', () => {
    const s = new AuditScoring({ fid: 150, gzipEnabled: true, browserCacheEnabled: true }); // fid > 100ms threshold
    assert.equal(s.scorePerformance().points, 20 - 3);
  });

  test('missing gzip is -3', () => {
    const s = new AuditScoring({ gzipEnabled: false, browserCacheEnabled: true });
    assert.equal(s.scorePerformance().points, 20 - 3);
  });
});

// ---------------------------------------------------------------------
// On-page SEO
// ---------------------------------------------------------------------
describe('scoreOnPage', () => {
  test('perfect page scores full 15 points', () => {
    const s = new AuditScoring({
      metaTitlePresent: true, metaTitleLength: 45,
      metaDescriptionPresent: true, metaDescriptionLength: 140,
      h1Present: true, h1Count: 1, h1Length: 40,
      structuredDataPresent: true,
    });
    assert.equal(s.scoreOnPage().points, 15);
  });

  test('missing title and description stack (-2 and -2)', () => {
    const s = new AuditScoring({ metaTitlePresent: false, metaDescriptionPresent: false, h1Present: true, h1Count: 1, structuredDataPresent: true });
    assert.equal(s.scoreOnPage().points, 15 - 2 - 2);
  });

  test('multiple H1 tags penalized same as missing (-2)', () => {
    const s = new AuditScoring({ metaTitlePresent: true, metaTitleLength: 45, metaDescriptionPresent: true, metaDescriptionLength: 140, h1Present: true, h1Count: 3, structuredDataPresent: true });
    assert.equal(s.scoreOnPage().points, 15 - 2);
  });

  test('duplicate content penalty scales per page (-2 each)', () => {
    const s = new AuditScoring({ metaTitlePresent: true, metaTitleLength: 45, metaDescriptionPresent: true, metaDescriptionLength: 140, h1Present: true, h1Count: 1, structuredDataPresent: true, duplicateContentPages: 3 });
    assert.equal(s.scoreOnPage().points, 15 - 6);
  });

  test('alt text: over 50% missing is -2, 25-50% is -1', () => {
    const base = { metaTitlePresent: true, metaTitleLength: 45, metaDescriptionPresent: true, metaDescriptionLength: 140, h1Present: true, h1Count: 1, structuredDataPresent: true };
    const s1 = new AuditScoring({ ...base, altTextMissingPercent: 60 });
    const s2 = new AuditScoring({ ...base, altTextMissingPercent: 30 });
    assert.equal(s1.scoreOnPage().points, 15 - 2);
    assert.equal(s2.scoreOnPage().points, 15 - 1);
  });

  test('structured data missing is -1, present with errors is also -1 (not both)', () => {
    const base = { metaTitlePresent: true, metaTitleLength: 45, metaDescriptionPresent: true, metaDescriptionLength: 140, h1Present: true, h1Count: 1 };
    const missing = new AuditScoring({ ...base, structuredDataPresent: false });
    const errors = new AuditScoring({ ...base, structuredDataPresent: true, structuredDataErrors: true });
    assert.equal(missing.scoreOnPage().points, 15 - 1);
    assert.equal(errors.scoreOnPage().points, 15 - 1);
  });
});

// ---------------------------------------------------------------------
// Mobile & UX — including the CLS-not-double-counted rule
// ---------------------------------------------------------------------
describe('scoreMobile', () => {
  test('perfect mobile scores full 10 points', () => {
    const s = new AuditScoring({ viewportPresent: true, mobileFriendly: true });
    assert.equal(s.scoreMobile().points, 10);
  });

  test('missing viewport is -3', () => {
    const s = new AuditScoring({ viewportPresent: false, mobileFriendly: true });
    assert.equal(s.scoreMobile().points, 10 - 3);
  });

  test('mobileFriendly: false is -4', () => {
    const s = new AuditScoring({ viewportPresent: true, mobileFriendly: false });
    assert.equal(s.scoreMobile().points, 10 - 4);
  });

  test('CLS is NOT penalized again in mobile scoring (avoids double-counting with performance)', () => {
    const s = new AuditScoring({ viewportPresent: true, mobileFriendly: true, cls: 0.5 });
    // even with a terrible CLS value present in the data, mobile score should be unaffected
    assert.equal(s.scoreMobile().points, 10);
  });
});

// ---------------------------------------------------------------------
// Aggregation, tiers, and the doc's own worked examples
// ---------------------------------------------------------------------
describe('calculateScore aggregation', () => {
  test('tiers match the doc thresholds', () => {
    assert.equal(AuditScoring.getTier(85).level, 'Excellent');
    assert.equal(AuditScoring.getTier(80).level, 'Excellent');
    assert.equal(AuditScoring.getTier(79.9).level, 'Bon');
    assert.equal(AuditScoring.getTier(60).level, 'Bon');
    assert.equal(AuditScoring.getTier(59.9).level, 'Moyen');
    assert.equal(AuditScoring.getTier(40).level, 'Moyen');
    assert.equal(AuditScoring.getTier(39.9).level, 'Critique');
    assert.equal(AuditScoring.getTier(0).level, 'Critique');
  });

  test('a fully clean site scores 100', () => {
    const s = new AuditScoring({
      robotsTxtPresent: true, sitemapPresent: true, pagesMissingCanonical: 0,
      hstsPresent: true, securityHeadersPresent: true,
      lcp: 1, inp: 50, cls: 0.02, ttfb: 100, gzipEnabled: true, browserCacheEnabled: true,
      metaTitlePresent: true, metaTitleLength: 45, metaDescriptionPresent: true, metaDescriptionLength: 140,
      h1Present: true, h1Count: 1, h1Length: 40, structuredDataPresent: true,
      viewportPresent: true, mobileFriendly: true,
    });
    assert.equal(s.calculateScore().final, 100);
  });

  test("Cas 1 from the doc ('E-commerce avec problèmes de performance') is close to the doc's stated 81.4", () => {
    // Reconstructed from the doc's stated points/max per category rather than
    // synthetic penalty flags, since the doc gives sub-scores directly.
    // NOTE: recomputing this by hand against the doc's own formula gives
    // 82.0 (or 81.9 using the doc's rounded display percentages), not 81.4 —
    // a small (~0.6 pt) discrepancy in the doc's own worked example. Flagged
    // in the README; this test documents the actual formula's output rather
    // than silently matching a number that doesn't reproduce from the stated
    // formula.
    const weights = { crawlability: 0.30, technical: 0.25, performance: 0.20, onPage: 0.15, mobile: 0.10 };
    const pcts = { crawlability: (28 / 30) * 100, technical: (24 / 25) * 100, performance: (10 / 20) * 100, onPage: (14 / 15) * 100, mobile: (6 / 10) * 100 };
    let final = 0;
    for (const k of Object.keys(pcts)) final += pcts[k] * weights[k];
    final = Math.round(final * 10) / 10;
    assert.equal(final, 82); // formula's true output; doc states 81.4
  });

  test("Cas 2 from the doc ('Blog mal indexé') is close to the doc's stated 59.5", () => {
    const weights = { crawlability: 0.30, technical: 0.25, performance: 0.20, onPage: 0.15, mobile: 0.10 };
    const pcts = { crawlability: (10 / 30) * 100, technical: (18 / 25) * 100, performance: (15 / 20) * 100, onPage: (10 / 15) * 100, mobile: (7 / 10) * 100 };
    let final = 0;
    for (const k of Object.keys(pcts)) final += pcts[k] * weights[k];
    final = Math.round(final * 10) / 10;
    assert.equal(final, 60); // formula's true output; doc states 59.5
  });

  test('issues are sorted by absolute point impact, worst first', () => {
    const s = new AuditScoring({ homepageNoindex: true, robotsTxtOversized: true }); // -15 and -2
    const { issues } = s.calculateScore();
    assert.equal(issues[0].points, -15);
    assert.ok(Math.abs(issues[0].points) >= Math.abs(issues[1].points));
  });
});
