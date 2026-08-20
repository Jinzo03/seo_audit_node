const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'audits.db');

/**
 * Opens (creating if needed) the SQLite database and ensures the audits
 * table exists. Synchronous by design — better-sqlite3 is sync-only, and
 * for a single-process app of this size that's simpler than adding async
 * ceremony around what's ultimately a local file.
 */
function initDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      start_url TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      final_score REAL NOT NULL,
      tier_level TEXT NOT NULL,
      pct_crawlability REAL NOT NULL,
      pct_technical REAL NOT NULL,
      pct_performance REAL NOT NULL,
      pct_onpage REAL NOT NULL,
      pct_mobile REAL NOT NULL,
      pages_crawled INTEGER NOT NULL,
      total_issues INTEGER NOT NULL,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audits_domain_time ON audits (domain, run_at);
  `);

  // Defensive upgrade path for a local audits.db created before details_json
  // existed — SQLite has no "ADD COLUMN IF NOT EXISTS", so just try and
  // ignore the error if the column is already there.
  try {
    db.exec('ALTER TABLE audits ADD COLUMN details_json TEXT');
  } catch (err) {
    // column already exists — fine
  }

  return db;
}

function domainFromUrl(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return url;
  }
}

/**
 * Persists one audit run. `scoreResult` is scoreSite()'s return value;
 * `pagesCrawled` and `startUrl` come from the crawl itself. `browserResults`
 * is optional (Playwright may not have run). Returns the inserted row's id.
 *
 * Stores the FULL scoreResult + browserResults as JSON, not just a
 * category-detail subset — this is what lets /report/:id reconstruct the
 * exact results page later (for the "back to results" and category
 * quick-switch navigation), not just the drill-down view. The crawled
 * pages themselves are NOT stored: results.ejs only ever reads
 * `pages.length`, which is already captured by `pagesCrawled` below.
 */
function saveAuditRun(db, {
  startUrl, pagesCrawled, scoreResult, browserResults = {}, geoCitations = null, runAt = Date.now(),
}) {
  const stmt = db.prepare(`
    INSERT INTO audits (
      domain, start_url, run_at, final_score, tier_level,
      pct_crawlability, pct_technical, pct_performance, pct_onpage, pct_mobile,
      pages_crawled, total_issues, details_json
    ) VALUES (@domain, @startUrl, @runAt, @finalScore, @tierLevel,
      @pctCrawlability, @pctTechnical, @pctPerformance, @pctOnpage, @pctMobile,
      @pagesCrawled, @totalIssues, @detailsJson)
  `);

  const info = stmt.run({
    domain: domainFromUrl(startUrl),
    startUrl,
    runAt,
    finalScore: scoreResult.final,
    tierLevel: scoreResult.tier.level,
    pctCrawlability: scoreResult.percentages.crawlability,
    pctTechnical: scoreResult.percentages.technical,
    pctPerformance: scoreResult.percentages.performance,
    pctOnpage: scoreResult.percentages.onPage,
    pctMobile: scoreResult.percentages.mobile,
    pagesCrawled,
    totalIssues: scoreResult.issues.length,
    detailsJson: JSON.stringify({ result: scoreResult, browserResults, geoCitations }),
  });

  return { ...info, id: info.lastInsertRowid };
}

/**
 * Loads one audit run by id, with the full scoreResult and browserResults
 * parsed back out of JSON. Returns null if the id doesn't exist. Falls back
 * to reconstructing a minimal `result` from the flattened summary columns
 * if details_json is missing/unparseable (e.g. a row saved before this
 * existed) — degraded but not broken.
 */
function getAuditById(db, id) {
  const row = db.prepare('SELECT * FROM audits WHERE id = ?').get(id);
  if (!row) return null;

  let result = null;
  let browserResults = {};
  let geoCitations = null;
  try {
    const parsed = JSON.parse(row.details_json || '{}');
    result = parsed.result || null;
    browserResults = parsed.browserResults || {};
    geoCitations = parsed.geoCitations || null;
  } catch (err) {
    result = null;
  }

  if (!result) {
    result = {
      final: row.final_score,
      tier: { level: row.tier_level, color: 'green' },
      percentages: {
        crawlability: row.pct_crawlability,
        technical: row.pct_technical,
        performance: row.pct_performance,
        onPage: row.pct_onpage,
        mobile: row.pct_mobile,
      },
      issues: [],
      categoryDetails: { crawlability: [], technical: [], performance: [], onPage: [], mobile: [] },
      notYetMeasured: [],
      crawlTimedOut: false,
      possibleSpaPages: [],
      ragReadiness: {
        totalPages: 0,
        pagesWithLongParagraphs: [],
        listsOrTablesPercent: 0,
        aiFriendlySchemaPercent: 0,
      },
    };
  }
  if (!result.ragReadiness) {
    result.ragReadiness = {
      totalPages: 0,
      pagesWithLongParagraphs: [],
      listsOrTablesPercent: 0,
      aiFriendlySchemaPercent: 0,
    };
  }

  return { ...row, result, browserResults, geoCitations };
}

/**
 * Past runs for the same domain, most recent first. Used to render the
 * historical trend section on the results page.
 */
function getAuditHistory(db, startUrl, limit = 12) {
  const domain = domainFromUrl(startUrl);
  return getAuditHistoryForDomain(db, domain, limit);
}

function getAuditHistoryForDomain(db, domain, limit = 12) {
  const stmt = db.prepare(`
    SELECT * FROM audits WHERE domain = @domain ORDER BY run_at DESC LIMIT @limit
  `);
  return stmt.all({ domain, limit });
}

function listAuditDomains(db, limit = 50) {
  const stmt = db.prepare(`
    SELECT
      domain,
      COUNT(*) AS audit_count,
      MAX(run_at) AS last_run_at,
      ROUND(AVG(final_score), 1) AS avg_score,
      MAX(final_score) AS best_score,
      SUM(pages_crawled) AS total_pages
    FROM audits
    GROUP BY domain
    ORDER BY last_run_at DESC
    LIMIT @limit
  `);
  return stmt.all({ limit });
}

function getDomainStats(db, domain, limit = 12) {
  const stats = db.prepare(`
    SELECT
      domain,
      COUNT(*) AS audit_count,
      MAX(run_at) AS last_run_at,
      ROUND(AVG(final_score), 1) AS avg_score,
      MAX(final_score) AS best_score,
      MIN(final_score) AS worst_score,
      SUM(pages_crawled) AS total_pages
    FROM audits
    WHERE domain = @domain
    GROUP BY domain
  `).get({ domain });

  if (!stats) return null;

  const latest = db.prepare(`
    SELECT id, start_url, run_at, final_score, tier_level, pages_crawled, total_issues
    FROM audits
    WHERE domain = @domain
    ORDER BY run_at DESC, id DESC
    LIMIT 1
  `).get({ domain });

  const history = getAuditHistoryForDomain(db, domain, limit).map((run) => ({
    id: run.id,
    startUrl: run.start_url,
    runAt: run.run_at,
    finalScore: run.final_score,
    tierLevel: run.tier_level,
    pagesCrawled: run.pages_crawled,
    totalIssues: run.total_issues,
    reportUrl: `/report/${run.id}`,
  }));

  return { ...stats, latest, history };
}

module.exports = {
  initDb,
  saveAuditRun,
  getAuditHistory,
  getAuditHistoryForDomain,
  getAuditById,
  listAuditDomains,
  getDomainStats,
  domainFromUrl,
  DEFAULT_DB_PATH,
};
