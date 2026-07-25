/**
 * Implements the scoring methodology from audit_scoring_methodology.docx.
 *
 * Two deliberate deviations from the literal spec, both flagged in the doc's
 * own numbers/tooling references:
 *   - Performance accepts `inp` (Interaction to Next Paint) as well as the
 *     spec's `fid` (First Input Delay). Google replaced FID with INP as the
 *     official Core Web Vital in March 2024; `fid` is still accepted for
 *     compatibility with the spec's literal wording, `inp` is preferred
 *     when both are present.
 *   - Mobile scoring does NOT re-penalize CLS >0.1, per the spec's own note
 *     that it's "déjà compté en performance" (already counted there).
 *
 * This module only computes a score from already-collected data — it does
 * not crawl or measure anything itself, so it's fully unit-testable with
 * synthetic input and has no dependency on the crawler.
 */

const WEIGHTS = {
  crawlability: 0.30,
  technical: 0.25,
  performance: 0.20,
  onPage: 0.15,
  mobile: 0.10,
};

const MAX_POINTS = {
  crawlability: 30,
  technical: 25,
  performance: 20,
  onPage: 15,
  mobile: 10,
};

class AuditScoring {
  constructor(auditData) {
    this.d = auditData;
  }

  // ------------------------------------------------------------------
  // A. Crawlabilité (30 pts)
  // ------------------------------------------------------------------
  scoreCrawlability() {
    const d = this.d;
    let score = 30;
    const issues = [];

    const deduct = (points, text, severity) => {
      score -= points;
      issues.push({ text, points: -points, severity });
    };

    if (!d.robotsTxtPresent) deduct(5, 'robots.txt absent ou mal configuré', 'WARNING');
    if (!d.sitemapPresent) deduct(3, 'sitemap.xml absent', 'WARNING');
    if (d.blockedCriticalResources) deduct(8, 'Blocage de fichiers CSS/JS importants', 'WARNING');
    if (d.robotsTxtOversized) deduct(2, 'Fichier robots.txt de taille excessive', 'NOTICE');
    if (d.homepageNoindex) deduct(15, "No-index sur la page d'accueil", 'CRITICAL');
    if (d.disallowAll) deduct(25, 'robots.txt bloque tout le site (Disallow: /)', 'CRITICAL');
    if (d.hreflangMisconfigured) deduct(4, 'Hreflang mal configuré', 'WARNING');
    if (d.pagesMissingCanonical > 0) deduct(3, 'Canonical tag manquant sur certaines pages', 'WARNING');

    return { points: Math.max(0, score), max: MAX_POINTS.crawlability, issues };
  }

  // ------------------------------------------------------------------
  // B. Problèmes techniques (25 pts)
  // ------------------------------------------------------------------
  scoreTechnical() {
    const d = this.d;
    let score = 25;
    const issues = [];

    const p404 = Math.min(8, Math.floor((d.errors404Count || 0) / 5));
    if (p404 > 0) { score -= p404; issues.push({ text: `${d.errors404Count} page(s) en erreur 404`, points: -p404, severity: 'WARNING' }); }

    const p5xx = Math.min(10, (d.errors5xxCount || 0) * 2);
    if (p5xx > 0) { score -= p5xx; issues.push({ text: `${d.errors5xxCount} page(s) en erreur 5xx`, points: -p5xx, severity: 'WARNING' }); }

    const pRedirects = Math.min(6, (d.redirectChainsCount || 0) * 3);
    if (pRedirects > 0) { score -= pRedirects; issues.push({ text: `${d.redirectChainsCount} redirect(s) chaîné(s) (>1 hop)`, points: -pRedirects, severity: 'WARNING' }); }

    if (d.redirectLoopsDetected) { score -= 10; issues.push({ text: 'Boucle(s) de redirection détectée(s)', points: -10, severity: 'CRITICAL' }); }
    if (d.mixedContent) { score -= 5; issues.push({ text: 'Contenu mixte (HTTPS + HTTP)', points: -5, severity: 'WARNING' }); }
    if (d.sslInvalid) { score -= 15; issues.push({ text: 'Certificat SSL invalide ou expiré', points: -15, severity: 'CRITICAL' }); }
    if (!d.hstsPresent) { score -= 2; issues.push({ text: 'Header HSTS manquant', points: -2, severity: 'NOTICE' }); }
    if (!d.securityHeadersPresent) { score -= 3; issues.push({ text: 'Security headers absents (CSP, X-Frame-Options, etc.)', points: -3, severity: 'NOTICE' }); }

    return { points: Math.max(0, score), max: MAX_POINTS.technical, issues };
  }

  // ------------------------------------------------------------------
  // C. Performance (20 pts)
  // ------------------------------------------------------------------
  scorePerformance() {
    const d = this.d;
    let score = 20;
    const issues = [];

    if (d.lcp !== undefined) {
      if (d.lcp > 4) { score -= 5; issues.push({ text: `LCP élevé (${d.lcp}s)`, points: -5, severity: 'WARNING' }); }
      else if (d.lcp >= 2.5) { score -= 2; issues.push({ text: `LCP moyen (${d.lcp}s)`, points: -2, severity: 'NOTICE' }); }
    }

    // FID -> INP: Google's Core Web Vitals replacement (March 2024). Prefer
    // inp when present; fall back to the spec's literal fid field otherwise.
    if (d.inp !== undefined) {
      if (d.inp > 200) { score -= 3; issues.push({ text: `INP élevé (${d.inp}ms)`, points: -3, severity: 'WARNING' }); }
    } else if (d.fid !== undefined) {
      if (d.fid > 100) { score -= 3; issues.push({ text: `FID élevé (${d.fid}ms)`, points: -3, severity: 'WARNING' }); }
    }

    if (d.cls !== undefined && d.cls > 0.1) {
      score -= 3; issues.push({ text: `CLS élevé (${d.cls})`, points: -3, severity: 'WARNING' });
    }

    if (d.ttfb !== undefined) {
      if (d.ttfb > 600) { score -= 4; issues.push({ text: `TTFB élevé (${d.ttfb}ms)`, points: -4, severity: 'WARNING' }); }
      else if (d.ttfb >= 300) { score -= 2; issues.push({ text: `TTFB moyen (${d.ttfb}ms)`, points: -2, severity: 'NOTICE' }); }
    }

    if (d.imagesUnoptimized) { score -= 2; issues.push({ text: 'Images non optimisées', points: -2, severity: 'NOTICE' }); }
    if (!d.gzipEnabled) { score -= 3; issues.push({ text: 'Compression gzip absente', points: -3, severity: 'WARNING' }); }
    if (!d.browserCacheEnabled) { score -= 2; issues.push({ text: 'Cache navigateur absent', points: -2, severity: 'NOTICE' }); }

    return { points: Math.max(0, score), max: MAX_POINTS.performance, issues };
  }

  // ------------------------------------------------------------------
  // D. On-page SEO (15 pts)
  // ------------------------------------------------------------------
  scoreOnPage() {
    const d = this.d;
    let score = 15;
    const issues = [];

    if (!d.metaTitlePresent) {
      score -= 2; issues.push({ text: 'Meta title absent', points: -2, severity: 'WARNING' });
    } else if (d.metaTitleLength !== undefined && (d.metaTitleLength < 30 || d.metaTitleLength > 60)) {
      score -= 1; issues.push({ text: `Longueur du meta title non idéale (${d.metaTitleLength} caractères)`, points: -1, severity: 'NOTICE' });
    }
    if (d.metaTitleDuplicate) { score -= 1; issues.push({ text: 'Meta title dupliqué sur le site', points: -1, severity: 'NOTICE' }); }

    if (!d.metaDescriptionPresent) {
      score -= 2; issues.push({ text: 'Meta description absente', points: -2, severity: 'WARNING' });
    } else if (d.metaDescriptionLength !== undefined && (d.metaDescriptionLength < 120 || d.metaDescriptionLength > 160)) {
      score -= 1; issues.push({ text: `Longueur de la meta description non idéale (${d.metaDescriptionLength} caractères)`, points: -1, severity: 'NOTICE' });
    }
    if (d.metaDescriptionDuplicate) { score -= 1; issues.push({ text: 'Meta description dupliquée sur le site', points: -1, severity: 'NOTICE' }); }

    if (!d.h1Present || (d.h1Count !== undefined && d.h1Count > 1)) {
      score -= 2; issues.push({ text: 'H1 absent ou multiple', points: -2, severity: 'WARNING' });
    } else if (d.h1Length !== undefined && (d.h1Length < 30 || d.h1Length > 65)) {
      score -= 1; issues.push({ text: `Longueur du H1 non idéale (${d.h1Length} caractères)`, points: -1, severity: 'NOTICE' });
    }

    if (d.brokenHeadingHierarchy) { score -= 1; issues.push({ text: 'Hiérarchie de titres cassée (H1 → H3 sans H2)', points: -1, severity: 'NOTICE' }); }
    if (d.tooManyH1) { score -= 1; issues.push({ text: 'Trop de H1 sur la page', points: -1, severity: 'NOTICE' }); }

    if (d.altTextMissingPercent !== undefined) {
      if (d.altTextMissingPercent > 50) { score -= 2; issues.push({ text: `${d.altTextMissingPercent}% des images sans alt text`, points: -2, severity: 'WARNING' }); }
      else if (d.altTextMissingPercent >= 25) { score -= 1; issues.push({ text: `${d.altTextMissingPercent}% des images sans alt text`, points: -1, severity: 'NOTICE' }); }
    }

    if (d.duplicateContentPages > 0) {
      const penalty = d.duplicateContentPages * 2;
      score -= penalty;
      issues.push({ text: `${d.duplicateContentPages} page(s) avec >50% de contenu dupliqué`, points: -penalty, severity: 'WARNING' });
    }
    if (d.boilerplatePercent !== undefined && d.boilerplatePercent > 30) {
      score -= 1; issues.push({ text: `Texte boilerplate élevé (${d.boilerplatePercent}%)`, points: -1, severity: 'NOTICE' });
    }

    if (!d.structuredDataPresent) {
      score -= 1; issues.push({ text: 'Structured data absent', points: -1, severity: 'NOTICE' });
    } else if (d.structuredDataErrors) {
      score -= 1; issues.push({ text: 'Erreurs dans le balisage JSON-LD', points: -1, severity: 'NOTICE' });
    }

    return { points: Math.max(0, score), max: MAX_POINTS.onPage, issues };
  }

  // ------------------------------------------------------------------
  // E. Mobile & UX (10 pts)
  // ------------------------------------------------------------------
  scoreMobile() {
    const d = this.d;
    let score = 10;
    const issues = [];

    if (!d.viewportPresent) { score -= 3; issues.push({ text: 'Viewport meta tag absent', points: -3, severity: 'WARNING' }); }
    if (d.mobileFriendly === false) { score -= 4; issues.push({ text: 'Mise en page non mobile-friendly', points: -4, severity: 'WARNING' }); }
    if (d.touchableElementsTooSmall) { score -= 2; issues.push({ text: 'Boutons/liens trop petits (<48px)', points: -2, severity: 'NOTICE' }); }
    if (d.fontTooSmall) { score -= 1; issues.push({ text: 'Police trop petite (<12px)', points: -1, severity: 'NOTICE' }); }
    if (d.lineHeightTooTight) { score -= 1; issues.push({ text: 'Interligne trop serré', points: -1, severity: 'NOTICE' }); }
    // CLS deliberately not re-penalized here — spec marks it "déjà compté en performance".
    if (d.intrusivePopups) { score -= 2; issues.push({ text: 'Popup intrusif au chargement', points: -2, severity: 'NOTICE' }); }

    return { points: Math.max(0, score), max: MAX_POINTS.mobile, issues };
  }

  // ------------------------------------------------------------------
  // Aggregation
  // ------------------------------------------------------------------
  static getTier(score) {
    if (score >= 80) return { level: 'Excellent', color: 'green' };
    if (score >= 60) return { level: 'Bon', color: 'yellow' };
    if (score >= 40) return { level: 'Moyen', color: 'orange' };
    return { level: 'Critique', color: 'red' };
  }

  calculateScore() {
    const categories = {
      crawlability: this.scoreCrawlability(),
      technical: this.scoreTechnical(),
      performance: this.scorePerformance(),
      onPage: this.scoreOnPage(),
      mobile: this.scoreMobile(),
    };

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
    };
  }
}

module.exports = { AuditScoring, WEIGHTS, MAX_POINTS };
