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
      total_issues INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audits_domain_time ON audits (domain, run_at);
  `);

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
 * `pagesCrawled` and `startUrl` come from the crawl itself.
 */
function saveAuditRun(db, { startUrl, pagesCrawled, scoreResult, runAt = Date.now() }) {
  const stmt = db.prepare(`
    INSERT INTO audits (
      domain, start_url, run_at, final_score, tier_level,
      pct_crawlability, pct_technical, pct_performance, pct_onpage, pct_mobile,
      pages_crawled, total_issues
    ) VALUES (@domain, @startUrl, @runAt, @finalScore, @tierLevel,
      @pctCrawlability, @pctTechnical, @pctPerformance, @pctOnpage, @pctMobile,
      @pagesCrawled, @totalIssues)
  `);

  return stmt.run({
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
  });
}

/**
 * Past runs for the same domain, most recent first. Used to render the
 * historical trend section on the results page.
 */
function getAuditHistory(db, startUrl, limit = 12) {
  const domain = domainFromUrl(startUrl);
  const stmt = db.prepare(`
    SELECT * FROM audits WHERE domain = @domain ORDER BY run_at DESC LIMIT @limit
  `);
  return stmt.all({ domain, limit });
}

module.exports = { initDb, saveAuditRun, getAuditHistory, domainFromUrl, DEFAULT_DB_PATH };
