const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb, saveAuditRun, getAuditHistory, domainFromUrl } = require('../src/storage/db');

function fakeScoreResult(overrides = {}) {
  return {
    final: 85.5,
    tier: { level: 'Excellent', color: 'green' },
    percentages: { crawlability: 100, technical: 90, performance: 80, onPage: 75, mobile: 100 },
    issues: [{ category: 'onPage', severity: 'NOTICE', points: -1, text: 'example' }],
    ...overrides,
  };
}

describe('storage/db', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-test-')), 'test.db');
    db = initDb(dbPath);
  });

  after(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('domainFromUrl extracts just the host', () => {
    assert.equal(domainFromUrl('https://example.com/some/path?x=1'), 'example.com');
  });

  test('domainFromUrl falls back to the raw input if URL parsing fails', () => {
    assert.equal(domainFromUrl('not-a-url'), 'not-a-url');
  });

  test('saveAuditRun inserts a row without throwing', () => {
    const result = saveAuditRun(db, {
      startUrl: 'https://example.com',
      pagesCrawled: 5,
      scoreResult: fakeScoreResult(),
    });
    assert.ok(result.changes === 1);
  });

  test('getAuditHistory returns saved runs for that domain', () => {
    const history = getAuditHistory(db, 'https://example.com');
    assert.ok(history.length >= 1);
    assert.equal(history[0].domain, 'example.com');
    assert.equal(history[0].final_score, 85.5);
    assert.equal(history[0].tier_level, 'Excellent');
  });

  test('getAuditHistory does not return runs from a different domain', () => {
    saveAuditRun(db, { startUrl: 'https://other-site.com', pagesCrawled: 3, scoreResult: fakeScoreResult({ final: 40 }) });
    const history = getAuditHistory(db, 'https://example.com');
    assert.ok(!history.some((r) => r.domain === 'other-site.com'));
  });

  test('getAuditHistory returns most recent runs first', () => {
    saveAuditRun(db, { startUrl: 'https://example.com', pagesCrawled: 5, scoreResult: fakeScoreResult({ final: 60 }), runAt: 1000 });
    saveAuditRun(db, { startUrl: 'https://example.com', pagesCrawled: 5, scoreResult: fakeScoreResult({ final: 70 }), runAt: 2000 });
    saveAuditRun(db, { startUrl: 'https://example.com', pagesCrawled: 5, scoreResult: fakeScoreResult({ final: 90 }), runAt: 3000 });
    const history = getAuditHistory(db, 'https://example.com');
    assert.ok(history[0].run_at >= history[1].run_at);
    assert.ok(history[1].run_at >= history[2].run_at);
  });

  test('getAuditHistory respects the limit parameter', () => {
    const history = getAuditHistory(db, 'https://example.com', 2);
    assert.equal(history.length, 2);
  });

  test('initDb is idempotent (calling it again on the same file does not error)', () => {
    const db2 = initDb(dbPath);
    assert.doesNotThrow(() => db2.prepare('SELECT 1').get());
    db2.close();
  });
});
