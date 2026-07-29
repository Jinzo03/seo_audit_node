/**
 * Run this yourself: node tests/manual_coldstart_check.js
 *
 * Launches ONE browser, then navigates to the same URL twice within that
 * same browser session, logging TTFB each time. If run 1 is dramatically
 * slower than run 2, that confirms the first navigation after a fresh
 * browser launch carries extra overhead (DNS/TLS/AV-scan/process startup)
 * that has nothing to do with the target site actually being slow —
 * which matters because runBrowserAudit() currently launches a brand-new
 * browser per audit, so every audit would pay that same cold-start tax.
 */

const { chromium, devices } = require('playwright');

async function measureTtfb(page, url) {
  const wallStart = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  const ttfb = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType('navigation');
    return entry ? Math.round(entry.responseStart) : null;
  });
  return { ttfb, wallMs: Date.now() - wallStart };
}

(async () => {
  const url = process.argv[2] || 'https://example.com';
  console.log(`Testing cold-start effect against ${url}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();

  const run1 = await measureTtfb(page, url);
  console.log(`Run 1 (fresh browser, first navigation): TTFB=${run1.ttfb}ms, wall=${run1.wallMs}ms`);

  const run2 = await measureTtfb(page, url);
  console.log(`Run 2 (same browser, second navigation):  TTFB=${run2.ttfb}ms, wall=${run2.wallMs}ms`);

  const dropPercent = run1.ttfb ? Math.round((1 - run2.ttfb / run1.ttfb) * 100) : 0;
  console.log(`\nRun 2 was ${dropPercent}% faster than Run 1.`);
  console.log(
    dropPercent > 50
      ? 'Strong sign of cold-start overhead — reuse a browser across audits (see runBrowserAudit\'s new `browser` option).'
      : 'Timings are close — the original TTFB may reflect a genuinely slow connection/server, not a cold-start artifact.',
  );

  await browser.close();
})();