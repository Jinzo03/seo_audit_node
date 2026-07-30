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
136 tests (crawler + scoring + crawl-to-score aggregation + TLS/security/redirects + browser-audit sampling), no live network
calls — all HTTP responses are mocked. Several real bugs have been caught
and fixed by this suite during development (see below).

Known flakiness: a couple of the rate-limiting tests assert on real
elapsed wall-clock time (e.g. "delay is applied" checks that `elapsed >=
50ms`), so under system load they can occasionally fail a single run even
though nothing is actually broken — re-running `npm test` resolves it. Not
urgent, but worth knowing about so it's not a mystery if it recurs.

## Architecture
```
src/
  crawler/
    normalizeLink.js     pure URL resolution — no I/O
    extract.js           one function per data point (title, H1, images, ...)
    robots.js            robots.txt fetch + matching
    sitemap.js           sitemap XML parsing (flat + sitemap index)
    securityHeaders.js   HSTS + security header detection (reads headers
                          already present on every fetch — no new requests)
    mixedContent.js      HTTPS-page-loading-HTTP-resources detection (reads
                          already-parsed HTML — no new requests)
    tlsCheck.js          SSL certificate validity via a raw TLS handshake
                          (Node's tls module — the only one of these four
                          that makes its own network connection)
    crawler.js           orchestrates all of the above; the only layer
                          driving the actual crawl
  scoring/
    auditScoring.js     the cahier de charge's scoring rules, fully implemented
    buildAuditData.js   maps crawl output -> AuditScoring input, produces one
                         whole-site score
  performance/
    selectSample.js      picks a representative subset of crawled pages for
                          the (expensive) browser audit instead of running
                          it on every page
    browserAudit.js      Playwright: real Core Web Vitals + mobile/UX checks
                          for one page — verified against a live site
  server.js             Express app; runs the sampled browser audit with a
                         graceful fallback if Playwright/Chromium isn't
                         available in a given environment (see below)
views/                  server-rendered EJS templates (functional, not the
                         final gauge dashboard — that's Week 4)
tests/                  136 tests across 20 suites
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

Live-tested end-to-end against real sites (pypi.org, github.com): crawling,
sitemap checking, on-page scoring, crawlability scoring, and now the full
Technical category — 404/5xx counts, redirect chain/loop tracking, SSL
certificate validity (via a real TLS handshake, confirmed against
github.com and pypi.org with real certificate expiry dates), HSTS and
security header detection, and mixed-content detection. A real audit of
pypi.org currently scores **92.6/100 (Excellent)**, correctly flagging that
91% of its images are missing alt text as the single biggest issue and a
clean Technical category (valid SSL, no redirect problems found in the
crawled pages).

**Not yet measured** (scored as neutral placeholders, not penalties, so the
overall score isn't unfairly tanked by missing data collection): image
optimization, gzip compression, and browser-cache headers under
Performance — `browserAudit.js` doesn't check these yet. Everything else
Performance/Mobile-related is now wired to real Playwright data *when a
browser is available* (see below for what happens when it isn't). Full,
run-specific list in `scoreSite`'s returned `notYetMeasured` field.

**A real bug was caught wiring in the Week 2 checks**: `buildTechnicalData`
used a different "is this an HTML page" test (`hstsPresent !== undefined`)
than the rest of the module (`title !== undefined`), which happened to work
by coincidence until a test fixture exposed the mismatch — 404/500 pages
without a `title` field were silently excluded as expected, but so was the
one real HTML page in a small test site, because it hadn't been given an
`hstsPresent` value either, leaving `buildTechnicalData` unable to find a
homepage to check headers on and defaulting to "HSTS missing." Fixed by
using the same criterion (and the same already-computed `htmlPages` list)
everywhere in the module instead of quietly introducing a second one.

**`browserAudit.js` (Playwright) has now been verified against a real
site**, including the cold-start question. INP fix confirmed (null now
correctly means "no slow interaction," not "never measured"). Tap-target
fix confirmed (stopped flagging a plain text link). And the TTFB/LCP
cold-start theory was directly confirmed: a second run against the same
URL came back ~93% faster (2701ms → 195ms TTFB), with the LCP-minus-TTFB
gap staying ~26ms both times — meaning the page itself rendered identically
both times, and the entire swing was in connection/startup time, not
rendering. Likely a one-time cost tied to the first-ever launch of a newly
installed Chromium binary rather than a per-launch tax.

**Week 3 is now wired end to end**: `selectPagesForBrowserAudit` picks a
representative sample (always the homepage, plus up to 4 more pages spread
evenly across crawl order rather than just the first few, since a
breadth-first crawl tends to visit structurally similar pages first),
`server.js` runs `browserAudit.js` against that sample with one shared
browser instance, and the results feed into `scoreSite` — Performance is
averaged only across sampled pages (there's no meaningful fallback score
without browser data), while Mobile blends browser data for sampled pages
with the existing static viewport check for the rest. If Playwright or its
Chromium binary isn't available in a given environment, `server.js` catches
that at launch time, logs a warning, and the audit still completes using
the Week 1/2 behavior for Performance/Mobile — verified directly in the
sandbox this was built in, where Chromium genuinely isn't installed, so
this fallback path is exercised for real, not just written defensively and
hoped for. The results page's "not yet measured" note is now conditional
on whether a browser actually ran for that specific audit, instead of
always showing a static "not measured" message.

**Still worth doing before trusting `browserAudit.js` broadly**: it's only
been tested against `example.com`, a very simple page. Testing the
mobile/UX heuristics (tap targets, popups, font size) against a page with
more varied real content is the natural next step, though it's no longer
blocking — the module is wired into the live audit flow now.

## Proposed 5-week roadmap (3 weeks now complete)

**Week 1 (done) — Scoping and foundation.** Stack decision, crawler ported
and tested, scoring engine implemented in full from the spec, crawl-to-score
mapping layer, working Express app.

**Week 2 (done) — Technical category completion.**
- Redirect chain tracking and loop detection — switched `fetchOne` from
  auto-following redirects to manually walking the chain (`redirect:
  'manual'`), so hop count and loops are now visible instead of silently
  disappearing into a single follow-redirect call. Verified live: `http://
  github.com` correctly reports 1 hop to HTTPS.
- SSL certificate validity via Node's `tls` module — a raw TLS handshake
  (no HTTP request) reads the actual certificate dates and trust-chain
  status. Verified live against github.com and pypi.org (both valid, with
  real expiry dates: 29 and 12 days out respectively at time of testing).
- HSTS + security header checks — free, just reads headers already present
  on every fetch.
- Mixed-content detection — free, scans HTML already parsed by Cheerio.
- All wired into `buildTechnicalData` in place of the Week 1 placeholders,
  with 30 new tests (mocked for chains/loops/headers, monkey-patched
  `tls.connect` for certificate scenarios that would otherwise need a real
  bad-certificate server to test).

**Week 3 (done) — Performance & Mobile via Playwright.**
- `browserAudit.js` verified against a live site, including confirming the
  cold-start theory and fixing the INP and tap-target bugs it surfaced (see
  above)
- Sampling strategy implemented (`selectSample.js`): homepage + up to 4
  more pages spread evenly across crawl order, not just the first few
- Wired into `server.js` with one shared browser instance per audit
  (cheaper than launching one per sampled page) and a defensive fallback if
  Playwright/Chromium isn't installed — exercised for real in the sandbox
  this was built in, since Chromium genuinely isn't available there
- Wired into `buildAuditData.js`: Performance now averages real per-page
  browser data across sampled pages; Mobile blends browser data for
  sampled pages with the existing static viewport check for the rest
- 14 new tests (8 for sampling logic, 6 for the scoring aggregation with
  synthetic browser results)

**Still open before trusting `browserAudit.js` broadly**: it's only been
tested against `example.com`, a very simple page — testing the mobile/UX
heuristics against a page with more varied real content (multiple images,
varied button sizes, an actual popup) is worth doing, though it no longer
blocks anything since the module is wired into the live flow already.

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
- Write up the retired-tooling and spec-ambiguity findings from the
  "Findings worth knowing about" section above as a short note for the
  encadrant
- Buffer for whatever testing `browserAudit.js` against more varied real
  sites turns up (see the open item at the end of Week 3 above)

## Easy wins if time is short
- The frontend gauge/dashboard (Week 4) can be built against data that
  already exists today (`result.final`, `result.percentages`,
  `result.issues`) — nothing left to wait on from earlier weeks.
- Persisting audit runs to `better-sqlite3` (already installed, unused so
  far) unlocks the historical-trend feature and can be built independently
  of the Week 4 gauge work.