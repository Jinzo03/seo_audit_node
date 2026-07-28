/**
 * Real Core Web Vitals + mobile/UX measurement using Playwright.
 *
 * IMPORTANT — this module could not be live-tested in the sandbox this was
 * written in: Playwright's browser binary download is blocked by that
 * environment's network allowlist (cdn.playwright.dev isn't reachable).
 * It's written against Playwright's documented API and the standard
 * PerformanceObserver-based technique the `web-vitals` library itself uses
 * internally, but you MUST run it yourself locally before trusting it:
 *
 *   npx playwright install chromium
 *   node -e "require('./src/performance/browserAudit').runBrowserAudit('https://example.com').then(r => console.log(r))"
 *
 * If anything about the metric collection looks off once you can actually
 * see real numbers, the most likely culprits are: (1) the LCP observer
 * firing before the largest element has actually loaded (page.waitForTimeout
 * below may need tuning per site), or (2) the popup/tap-target heuristics
 * being too strict/loose for a given site's markup conventions.
 */

const { chromium, devices } = require('playwright');

async function runBrowserAudit(url, options = {}) {
  const { mobile = true, timeoutMs = 15000, settleMs = 1500 } = options;

  const browser = await chromium.launch();
  try {
    const context = mobile
      ? await browser.newContext({ ...devices['Pixel 7'] })
      : await browser.newContext();
    const page = await context.newPage();

    // Registered before navigation so it captures metrics from the very
    // start of the page load, not just from whenever we happen to poll.
    await page.addInitScript(() => {
      window.__vitals = { lcp: null, cls: 0, inp: null };

      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) window.__vitals.lcp = last.renderTime || last.loadTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) { /* LCP not supported in this browser context */ }

      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__vitals.cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) { /* CLS not supported */ }

      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (window.__vitals.inp === null || entry.duration > window.__vitals.inp) {
              window.__vitals.inp = entry.duration;
            }
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
      } catch (e) { /* INP/event timing not supported */ }
    });

    let response = null;
    let navError = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    } catch (err) {
      navError = err.message;
    }

    // Give layout-shift/LCP observers a little more time to settle after load.
    await page.waitForTimeout(settleMs);

    const vitals = await page.evaluate(() => window.__vitals);
    const ttfb = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation');
      return entry ? Math.round(entry.responseStart) : null;
    });

    const viewportPresent = (await page.$('meta[name="viewport"]')) !== null;
    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    const touchableElementsTooSmall = await checkTapTargets(page);
    const { fontTooSmall, lineHeightTooTight } = await checkTypography(page);
    const intrusivePopups = await checkForPopups(page);

    await context.close();

    return {
      navigationError: navError,
      statusCode: response ? response.status() : null,
      lcp: vitals.lcp !== null ? Math.round(vitals.lcp) / 1000 : null, // seconds
      inp: vitals.inp !== null ? Math.round(vitals.inp) : null, // ms
      cls: Math.round(vitals.cls * 1000) / 1000,
      ttfb, // ms
      viewportPresent,
      mobileFriendly: viewportPresent && noHorizontalScroll,
      touchableElementsTooSmall,
      fontTooSmall,
      lineHeightTooTight,
      intrusivePopups,
    };
  } finally {
    await browser.close();
  }
}

async function checkTapTargets(page) {
  return page.evaluate(() => {
    const clickable = document.querySelectorAll('a, button, input, select, textarea');
    for (const el of clickable) {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (visible && (rect.width < 48 || rect.height < 48)) return true;
    }
    return false;
  });
}

async function checkTypography(page) {
  return page.evaluate(() => {
    let fontTooSmall = false;
    let lineHeightTooTight = false;
    const textNodes = document.querySelectorAll('p, li, span, div, a');
    for (const el of textNodes) {
      const style = window.getComputedStyle(el);
      const fontSize = parseFloat(style.fontSize);
      const lineHeight = parseFloat(style.lineHeight);
      if (fontSize && fontSize < 12) fontTooSmall = true;
      if (fontSize && lineHeight && !Number.isNaN(lineHeight) && lineHeight / fontSize < 1.2) {
        lineHeightTooTight = true;
      }
      if (fontTooSmall && lineHeightTooTight) break;
    }
    return { fontTooSmall, lineHeightTooTight };
  });
}

async function checkForPopups(page) {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[class*="modal"], [class*="popup"], [id*="modal"], [id*="popup"], [role="dialog"]',
    );
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width >= window.innerWidth * 0.7 && rect.height >= window.innerHeight * 0.7;
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      if (coversViewport && visible) return true;
    }
    return false;
  });
}

module.exports = { runBrowserAudit };
