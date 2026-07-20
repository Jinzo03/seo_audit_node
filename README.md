# Audit Site — Scoring SEO (Node.js)

Implementation of `audit_scoring_methodology.docx` — a 100-point, 5-category
weighted SEO audit score, in Node.js/Express per the encadrant's stack
requirement.

## Run it
```bash
npm install
npm start
```
Open http://localhost:3000, enter a URL, run an audit.

## Run the tests
```bash
npm test
```
92 tests (crawler + scoring + crawl-to-score aggregation), no live network
calls — all HTTP responses are mocked. Two real bugs were caught and fixed
by this suite during development (see below).

## Architecture
```
src/
  crawler/
    normalizeLink.js   pure URL resolution — no I/O
    extract.js         one function per data point (title, H1, images, ...)
    robots.js           robots.txt fetch + matching
    sitemap.js           sitemap XML parsing (flat + sitemap index)
    crawler.js          orchestrates the above; the only layer touching HTTP
  scoring/
    auditScoring.js     the cahier de charge's scoring rules, fully implemented
    buildAuditData.js   maps crawl output -> AuditScoring input, produces one
                         whole-site score
  performance/
    browserAudit.js     Playwright: real Core Web Vitals + mobile/UX checks
                         (NOT YET LIVE-TESTED — see below)
  server.js             Express app tying it together
views/                  server-rendered EJS templates (functional, not the
                         final gauge dashboard — that's Week 4)
tests/                  92 tests across 14 suites
```

## Findings worth knowing about

**Two tools/metrics named in the spec no longer exist in their original
form**, discovered while researching how to implement them:
- The **Google Mobile-Friendly Test** (tool + API) was retired by Google in
  December 2023. `browserAudit.js` approximates its core checks (viewport
  tag, no horizontal scroll) directly via Playwright instead.
- **FID** (First Input Delay) was replaced by **INP** (Interaction to Next
  Paint) as the official third Core Web Vital in March 2024. The scoring
  engine accepts either field, preferring `inp` when present.

**The cahier de charge's own two worked examples don't quite reproduce from
its own formula.** Recomputing "Cas 1" (28/30, 24/25, 10/20, 14/15, 6/10)
gives 82.0, not the doc's stated 81.4; "Cas 2" gives 60.0, not 59.5. Both are
off by roughly the same amount in the same direction — worth a two-line
heads-up to the encadrant, not a real problem, but good to flag rather than
silently "fix" the code to match numbers that don't reproduce from the
stated formula. See `tests/scoring.test.js` for the exact reconstruction.

**The spec is ambiguous about whether scoring is per-page or per-site.**
Crawlability and Technical rules are clearly site-wide (robots.txt/sitemap
exist once; 404/5xx are counts across pages). On-page and Mobile rules read
like a single page's evaluation, but the dashboard description implies one
score per site. Resolved here by averaging on-page/mobile scores across all
crawled pages — a judgment call worth confirming with the encadrant if
grading depends on it. See the comment block at the top of
`buildAuditData.js`.

**A real robots.txt bug was caught by the test suite** (carried over from
the Python version, and independently re-verified against `robots-parser`'s
actual behavior rather than assumed): using a full versioned `User-Agent`
string to check `robots.txt` permissions can silently fail to match a rule
written for the bare bot name. `crawler.js` matches against a bare
`ROBOTS_TOKEN`, separate from the descriptive header string sent with
requests.

**A sitemap-parsing bug was caught by the test suite**: `fast-xml-parser`
returns an empty string (not an object) for a childless XML element, so a
truthiness check on `parsed.urlset` incorrectly treated an *empty* sitemap
(zero URLs) as "not a recognizable sitemap" and threw. Fixed by checking key
presence instead of truthiness. See `sitemap.js`.

## What's real vs. placeholder right now

Live-tested end-to-end against real sites (pypi.org): crawling, sitemap
checking, on-page scoring, crawlability scoring, technical scoring (404/5xx
counts). A real audit of pypi.org currently scores **92.6/100 (Excellent)**,
correctly flagging that 91% of its images are missing alt text as the
single biggest issue.

**Not yet measured** (scored as neutral placeholders, not penalties, so the
overall score isn't unfairly tanked by missing data collection): redirect
chains/loops, mixed content, SSL certificate validity, HSTS/security
headers, all of Performance (Core Web Vitals, TTFB, compression, caching),
and most of Mobile/UX beyond the viewport tag. Full list in
`buildAuditData.js`'s `NOT_YET_MEASURED`.

**`browserAudit.js` (Playwright) could not be live-tested in the sandbox
this was built in** — its browser binary download is blocked by that
environment's network allowlist. It's written against Playwright's
documented API and the same technique the `web-vitals` library uses
internally (`PerformanceObserver` for LCP/CLS/INP), but you need to verify
it yourself before trusting it:
```bash
npx playwright install chromium
node -e "require('./src/performance/browserAudit').runBrowserAudit('https://example.com').then(r => console.log(r))"
```

## Proposed 5-week roadmap (1 week already spent on scoping/foundation)

**Week 2 — Technical category + real redirect/SSL/header checks**
- Redirect chain tracking (httpx/fetch response history) and loop detection
- SSL certificate validity via Node's `tls` module
- HSTS + security header checks (trivial — just read response headers)
- Mixed-content detection (scan HTTPS pages for HTTP sub-resources)
- Wire real values into `buildTechnicalData` in place of the current
  placeholders

**Week 3 — Performance & Mobile via Playwright**
- Verify `browserAudit.js` locally, fix whatever the real browser reveals
  (this file is unverified — budget real debugging time here)
- Decide sampling strategy: running a full browser pass on every crawled
  page is slow: likely sample N pages (e.g. homepage + 4-5 representative
  pages) rather than every page, like real audit tools do
- Wire results into `buildAuditData` in place of current placeholders

**Week 4 — Frontend / dashboard**
- Circular score gauge with dynamic color + load animation (SVG or Canvas)
- 5 sub-score progress bars (have the data already — just needs the visual)
- Filterable/sortable issues list by severity
- Historical trend: needs persistence — `better-sqlite3` is already
  installed; store each audit run keyed by domain + timestamp

**Week 5 — Polish, edge cases, report generation, buffer**
- PDF/exportable report generation
- Handle edge cases: JS-rendered sites (SPA detection), very large sites,
  crawl timeouts
- Write up the two documentation findings above as a short note for the
  encadrant
- Buffer for whatever Week 3's Playwright debugging actually turns up

## Easy wins if time is short
- Redirect/SSL/header checks (Week 2 list) are all cheap — no browser
  needed, just reading response metadata already available from `fetch`.
- The frontend gauge can be built against the data that already exists
  today (`result.final`, `result.percentages`) without waiting for Week 2/3.
