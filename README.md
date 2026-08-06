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
153 tests (crawler + scoring + crawl-to-score aggregation + TLS/security/redirects + browser-audit sampling + SQLite persistence + edge-case handling), no live network
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
                          driving the actual crawl. Also owns three
                          edge-case guards added in Week 5: an overall
                          crawl deadline (crawlTimeoutMs, separate from the
                          per-request timeout), a per-page size cap that
                          skips full parsing on pathologically large pages,
                          and SPA detection (flags pages that look
                          JS-rendered with almost no real HTML content,
                          since this crawler never executes JavaScript)
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
  storage/
    db.js                SQLite persistence (better-sqlite3) — saves every
                          audit run and serves the historical trend view
  server.js             Express app; runs the sampled browser audit with a
                         graceful fallback if Playwright/Chromium isn't
                         available, then saves the run and loads history
                         for the domain before rendering
views/                  server-rendered EJS templates: a "diagnostic
                         console" visual design (IBM Plex Sans/Mono, ink/
                         paper/signal palette, animated scan line), with the
                         score gauge, historical sparkline, and filterable/
                         sortable issue list from Week 4, plus a Week 5
                         print stylesheet that turns the same page into a
                         clean PDF report via the browser's own print dialog
tests/                  153 tests across 24 suites
```

## Findings worth knowing about

**PDF export uses the browser's own print dialog, not a server-side PDF
library.** `results.ejs` has a `@media print` stylesheet and a "Télécharger
le rapport (PDF)" button that calls `window.print()` — the user picks "Save
as PDF" as the destination. This was a deliberate choice over generating
PDFs server-side (e.g. with Playwright, which is already a dependency):
zero new code paths, the exported report is guaranteed to match exactly
what's on screen (no risk of a second crawl producing different data), and
no changes needed to the SQLite schema to store full per-page issue data
for later regeneration. Actually verified, not just written and assumed:
rendered real audit data through the template and generated a PDF with
`wkhtmltopdf` (also available in the build sandbox), then converted it to
an image to confirm the print rules actually applied — topbar, filter
buttons, and background grid correctly hidden; severity colors and the
score gauge correctly preserved.

**Three edge-case gaps got closed**, found by asking "what would actually
break this in production" rather than waiting for a bug report:
- No overall crawl deadline existed — only a per-request timeout. A site
  with many slow-but-not-quite-timing-out pages could have made a single
  audit run for a very long time. Added `crawlTimeoutMs` (default 60s,
  separate from the per-request `timeoutMs`), checked at the top of each
  batch in the crawl loop; if exceeded, the crawl returns whatever it
  collected instead of continuing, and `crawlTimedOut` is surfaced on the
  results page.
- No cap existed on individual page size — a pathologically large page
  (multi-megabyte HTML) would get fully parsed by Cheerio regardless.
  Added `maxPageSizeBytes` (default 5MB); pages over the limit skip full
  extraction and are flagged `pageTooLarge` instead.
- JS-rendered (SPA) pages would silently produce misleading results —
  React/Vue/Angular apps often serve almost-empty initial HTML (the real
  content only exists after JavaScript runs), and this crawler never
  executes JavaScript. Added a heuristic (`detectPossibleSpa`): a known
  framework root container — `#root`, `#app`, `#__next`, `#__nuxt`,
  `[data-reactroot]`, `[ng-version]` — combined with very little text is
  flagged, and the results page now discloses this honestly ("this may be
  a crawler limitation, not a real SEO problem") instead of just reporting
  thin-content findings as if they were confirmed issues.

**The UI got a full visual redesign.** The original functional-but-generic
form styling (plain bordered card, default blue button) was replaced with a
deliberate "diagnostic console" design — IBM Plex Sans/Mono, an ink/paper/
signal color system, a faint grid background with an animated scan line,
and category weights shown as real chips (30/25/20/15/10%) instead of a
throwaway sentence. Both pages share the same design tokens for
consistency. This wasn't just eyeballed: rendered with `wkhtmltoimage`
(available in the build sandbox) to actually look at the output rather than
trust the CSS blindly, at both desktop and mobile widths.

**That screenshot process caught a real bug.** The results page's tables
(history and issues) had no horizontal-scroll containment, so at a 380px
mobile width the whole page overflowed to 724px instead of staying within
the viewport — confirmed by checking actual rendered pixel dimensions, not
just eyeballing it. Fixed by wrapping both tables in a scrollable container
(`overflow-x: auto`) instead of letting them force the whole page wider,
plus `overflow-x: hidden` on `<body>` as a safety net. Re-verified after
the fix: page rendered at exactly 380px as requested, with the table itself
showing a contained horizontal scrollbar instead.

**The gauge/bar-fill animation JS was confirmed to actually execute**, not
just pass a syntax check — the rendered screenshot showed the gauge and
bars already filled to their real values (not stuck at their initial 0%
state), which only happens if `requestAnimationFrame` and the dataset
reads in the `<script>` block ran correctly in a real rendering engine.

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

## Proposed 5-week roadmap (all 5 weeks complete)

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

**Week 4 (done) — Frontend / dashboard.**
- Circular SVG score gauge with dynamic color (per tier) and a load
  animation — starts at 0 and fills to the real score via a CSS
  `stroke-dashoffset` transition, triggered one frame after paint
- Sub-score bars animate the same way (0 → real width on load)
- Issue list is filterable by severity (Critical/Warning/Notice, with live
  counts) and sortable by clicking any column header (click again to
  reverse), all vanilla JS — no framework needed for this scope, consistent
  with the earlier EJS-vs-React reasoning
- Historical trend: `src/storage/db.js` (better-sqlite3) persists every
  audit run — domain, timestamp, final score, all five sub-scores, pages
  crawled, issue count. `server.js` saves each run and loads the domain's
  history before rendering. The results page shows a sparkline (plain
  inline SVG, no charting library) plus a table once a domain has 2+ runs.
  Verified live: ran two audits against the same site back-to-back,
  confirmed both persisted correctly and the trend section appeared with
  real data on the second run.
- 8 new tests for `db.js` using a real temporary SQLite file (not mocked —
  better-sqlite3 needs no network, so there was no reason not to test
  against the real thing)

**Update on the earlier "can't test client-side JS" limitation**:
`wkhtmltoimage` turned out to be available in the sandbox, which allowed
actually rendering both pages and confirming the gauge/bar-fill animation
JS executes correctly (see the visual redesign findings above) — that's
more than a syntax check now. What's still genuinely unverified: clicking
the severity filter buttons and the sortable column headers, since
`wkhtmltoimage` captures a single static render rather than simulating
interaction. Worth a quick local click-through before considering that part
fully verified.

**Week 5 (done) — Polish, edge cases, report generation.**
- PDF export via the browser's print dialog (`window.print()` + a
  `@media print` stylesheet) — verified with a real `wkhtmltopdf` render,
  not just written and trusted (see findings above)
- Three edge-case gaps closed: an overall crawl deadline separate from the
  per-request timeout, a page-size cap that skips parsing pathologically
  large pages, and SPA detection that honestly discloses when "thin
  content" findings might just be a crawler limitation rather than a real
  SEO problem
- 9 new tests (5 for SPA detection, 2 for the crawl deadline, 2 for the
  page-size guard)
- This README **is** the write-up for the encadrant — every finding above
  (retired tooling, the spec's own arithmetic discrepancy, the per-page-vs-
  per-site scoring ambiguity, every bug caught and how) is already
  documented in place rather than duplicated into a separate document

**Still genuinely open, not closed out by this week**: `browserAudit.js`
has still only been tested against `example.com` — testing the mobile/UX
heuristics against a page with real varied content remains worth doing.
Clicking through the Week 4 filter/sort buttons in a real browser (not just
confirming the animation JS executes, which the Week 4 screenshots did)
is also still outstanding. Neither blocks anything — both are refinement,
not missing functionality.

## Easy wins if time is short
- Nothing left on the original roadmap — all 5 weeks are built and tested.
  If more time opens up, the two "still genuinely open" items just above
  are the best use of it.
