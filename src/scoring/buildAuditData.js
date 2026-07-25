/**
 * Turns raw crawl output into the auditData shape AuditScoring expects, and
 * produces one whole-site score.
 *
 * A genuine ambiguity in the cahier de charge, flagged here rather than
 * silently resolved: the scoring rules for Crawlability and Technical are
 * clearly site-wide (robots.txt/sitemap exist once per site; 404/5xx counts
 * are totals across pages) — but the On-page and Mobile rules read like a
 * single page's evaluation (one title, one H1, one viewport tag), while the
 * doc's dashboard description ("Comparaison historique sur 6 mois") implies
 * ONE score per site, not one per page.
 *
 * Resolution used here: Crawlability and Technical are computed once,
 * site-wide. On-page and Mobile are computed PER PAGE, then averaged across
 * all crawled pages to produce the site's sub-score. This is a judgment
 * call, not something stated explicitly in the spec — worth confirming with
 * the encadrant if it matters for grading.
 *
 * Fields NOT YET measured by the crawler (redirect chains/loops, mixed
 * content, SSL validity, HSTS, security headers, and everything under
 * Performance + most of Mobile/UX beyond the viewport tag) are left at
 * neutral, non-penalizing defaults rather than silently scored as "bad" —
 * see NOT_YET_MEASURED below. Wiring in src/performance/browserAudit.js
 * (Playwright) replaces these placeholders once that module is verified
 * working locally.
 */

const { AuditScoring, WEIGHTS } = require('./auditScoring');

const NOT_YET_MEASURED = [
  'robotsTxtOversized',
  'blockedCriticalResources',
  'hreflangMisconfigured',
  'redirectChainsCount',
  'redirectLoopsDetected',
  'mixedContent',
  'sslInvalid',
  'hstsPresent',
  'securityHeadersPresent',
  'lcp',
  'inp',
  'cls',
  'ttfb',
  'imagesUnoptimized',
  'gzipEnabled',
  'browserCacheEnabled',
  'mobileFriendly',
  'touchableElementsTooSmall',
  'fontTooSmall',
  'lineHeightTooTight',
  'intrusivePopups',
];

function countOccurrences(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

function buildCrawlabilityData(pages, sitemapResult, robots, startUrl) {
  const homepage = pages.find((p) => p.url === startUrl || p.url === `${startUrl}/`) || pages[0];
  const homepageNoindex = Boolean(
    homepage && homepage.metaRobots && homepage.metaRobots.toLowerCase().includes('noindex'),
  );

  let disallowAll = false;
  if (robots) {
    try {
      disallowAll = robots.isAllowed(startUrl, '*') === false;
    } catch (err) {
      disallowAll = false;
    }
  }

  const pagesMissingCanonical = pages.filter(
    (p) => p.statusCode && p.statusCode < 400 && !p.canonical,
  ).length;

  return {
    robotsTxtPresent: robots !== null,
    sitemapPresent: sitemapResult.found,
    homepageNoindex,
    disallowAll,
    pagesMissingCanonical,
    blockedCriticalResources: undefined,
    robotsTxtOversized: undefined,
    hreflangMisconfigured: undefined,
  };
}

function buildTechnicalData(pages) {
  return {
    errors404Count: pages.filter((p) => p.statusCode === 404).length,
    errors5xxCount: pages.filter((p) => p.statusCode && p.statusCode >= 500).length,
    // Placeholder "clean" values for checks we don't measure yet. Using
    // true/false (not undefined) because scoreTechnical uses `if (!d.x)`
    // for these, which would otherwise treat "not measured" as "missing".
    hstsPresent: true,
    securityHeadersPresent: true,
    redirectChainsCount: 0,
    redirectLoopsDetected: false,
    mixedContent: false,
    sslInvalid: false,
  };
}

function buildOnPageDataForPage(page, titleCounts, descriptionCounts) {
  const structuredDataPresent = (page.structuredDataRaw || []).length > 0;
  const structuredDataErrors = (page.structuredDataRaw || []).some((raw) => {
    try {
      JSON.parse(raw);
      return false;
    } catch (err) {
      return true;
    }
  });

  const imageCount = page.imageCount || 0;
  const altTextMissingPercent = imageCount > 0
    ? Math.round(((page.imagesMissingAlt || 0) / imageCount) * 100)
    : 0;

  return {
    metaTitlePresent: Boolean(page.title),
    metaTitleLength: page.title ? page.title.length : undefined,
    metaTitleDuplicate: page.title ? (titleCounts.get(page.title) || 0) > 1 : false,

    metaDescriptionPresent: Boolean(page.metaDescription),
    metaDescriptionLength: page.metaDescription ? page.metaDescription.length : undefined,
    metaDescriptionDuplicate: page.metaDescription
      ? (descriptionCounts.get(page.metaDescription) || 0) > 1
      : false,

    h1Present: (page.h1Count || 0) > 0,
    h1Count: page.h1Count || 0,
    h1Length: page.h1Text ? page.h1Text.length : undefined,

    brokenHeadingHierarchy: Boolean(page.brokenHeadingHierarchy),
    tooManyH1: (page.h1Count || 0) > 1,

    altTextMissingPercent,
    duplicateContentPages: 0, // applied at site level, not per page
    boilerplatePercent: undefined,

    structuredDataPresent,
    structuredDataErrors,
  };
}

function buildMobileDataForPage(page) {
  return {
    viewportPresent: Boolean(page.hasViewport),
    mobileFriendly: undefined,
    touchableElementsTooSmall: undefined,
    fontTooSmall: undefined,
    lineHeightTooTight: undefined,
    intrusivePopups: undefined,
  };
}

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

/**
 * Compute one whole-site score from crawl results.
 * `pages` and `sitemapResult` come straight from Crawler#crawl() /
 * Crawler#checkSitemap(); `robots` is crawler.robots after ensureRobotsLoaded.
 */
function scoreSite({ pages, sitemapResult, robots, startUrl, duplicateContentPageCount = 0 }) {
  const htmlPages = pages.filter((p) => p.title !== undefined);

  const titleCounts = countOccurrences(htmlPages.map((p) => p.title).filter(Boolean));
  const descriptionCounts = countOccurrences(htmlPages.map((p) => p.metaDescription).filter(Boolean));

  const crawlabilityData = buildCrawlabilityData(pages, sitemapResult, robots, startUrl);
  const technicalData = buildTechnicalData(pages);

  const onPageScores = htmlPages.map((p) => {
    const data = buildOnPageDataForPage(p, titleCounts, descriptionCounts);
    if (data === htmlPages[0] && duplicateContentPageCount > 0) {
      data.duplicateContentPages = duplicateContentPageCount;
    }
    return new AuditScoring(data).scoreOnPage();
  });

  const mobileScores = htmlPages.map((p) => new AuditScoring(buildMobileDataForPage(p)).scoreMobile());

  const crawlability = new AuditScoring(crawlabilityData).scoreCrawlability();
  const technical = new AuditScoring(technicalData).scoreTechnical();

  const onPage = {
    points: onPageScores.length ? Math.round(average(onPageScores.map((r) => r.points)) * 10) / 10 : 15,
    max: 15,
    issues: onPageScores.flatMap((r) => r.issues).slice(0, 10),
  };
  const mobile = {
    points: mobileScores.length ? Math.round(average(mobileScores.map((r) => r.points)) * 10) / 10 : 10,
    max: 10,
    issues: mobileScores.flatMap((r) => r.issues).slice(0, 10),
  };

  // No per-page browser data yet — neutral placeholder until
  // src/performance/browserAudit.js (Playwright) is wired in and verified.
  const performance = { points: 20, max: 20, issues: [] };

  const categories = { crawlability, technical, performance, onPage, mobile };

  const percentages = {};
  let final = 0;
  for (const key of Object.keys(categories)) {
    const pct = (categories[key].points / categories[key].max) * 100;
    percentages[key] = Math.round(pct * 10) / 10;
    final += pct * WEIGHTS[key];
  }
  final = Math.round(final * 10) / 10;

  const allIssues = [];
  for (const [key, cat] of Object.entries(categories)) {
    for (const issue of cat.issues) allIssues.push({ category: key, ...issue });
  }
  allIssues.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    final,
    tier: AuditScoring.getTier(final),
    categories,
    percentages,
    issues: allIssues,
    notYetMeasured: NOT_YET_MEASURED,
  };
}

module.exports = {
  scoreSite,
  buildCrawlabilityData,
  buildTechnicalData,
  buildOnPageDataForPage,
  buildMobileDataForPage,
  NOT_YET_MEASURED,
};
