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
177 tests (crawler + scoring + crawl-to-score aggregation + TLS/security/redirects + browser-audit sampling + SQLite persistence + edge-case handling + category drill-down + RAG/GEO readiness + background audit jobs), no live network
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
    extract.js           one function per data point (title, H1, images,
                          ...) plus RAG/GEO readiness signals (paragraph
                          length, lists/tables, FAQ/HowTo schema) — a
                          bonus insight kept explicitly separate from the
                          cahier de charge's scored categories
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
    auditScoring.js     the cahier de charge's scoring rules, fully
                         implemented; every issue carries a stable `code`
                         (e.g. 'missing_canonical') used to trace it back to
                         the specific pages it affects
    buildAuditData.js   maps crawl output -> AuditScoring input, produces one
                         whole-site score
  performance/
    selectSample.js      picks a representative subset of crawled pages for
                          the (expensive) browser audit instead of running
                          it on every page
    browserAudit.js      Playwright: real Core Web Vitals + mobile/UX checks
                          for one page — verified against a live site
  geo/
    citations.js         optional SerpApi-powered Google AI Overview
                          citation tracking, kept as a bonus GEO signal
                          outside the official 100-point SEO score
  storage/
    db.js                SQLite persistence (better-sqlite3) — saves every
                          audit run (now including full category-level
                          issue detail as JSON) and serves both the
                          historical trend view and the category drill-down
                          page
  server.js             Express app; POST /audit starts a background audit
                         job and returns immediately. GET /audit/jobs/:id
                         exposes status for polling, and completed jobs
                         point to GET /report/:id, the actual results page,
                         reloadable and linkable. Also serves the category
                         drill-down route (GET /report/:id/category/:key),
                         with a graceful fallback if Playwright/Chromium
                         isn't available for the browser audit step
views/                  server-rendered EJS templates: a "diagnostic
                         console" visual design (IBM Plex Sans/Mono, ink/
                         paper/signal palette, animated scan line).
                         index.ejs is the audit form; results.ejs has the
                         score gauge, Core Web Vitals indicators, historical
                         sparkline, and filterable/sortable issue list, plus
                         a print stylesheet for PDF export; category.ejs
                         lists every page affected by a given category's
                         issues (with a link to each), plus tabs to jump
                         directly between categories and a button back to
                         the results page for the same audit
tests/                  177 tests across 27 suites
```

## Findings worth knowing about

**Added a RAG/GEO readiness feature — deliberately scoped down from a
larger proposal, and deliberately kept out of the official score.** Three
signals for how well content is formatted for AI answer engines (ChatGPT,
Perplexity, AI Overviews): paragraphs over 300 words (harder for an LLM to
cleanly extract a single answer from), presence of lists/tables (extracted
cleanly, unlike prose), and FAQPage/HowTo/QAPage structured data (consumed
directly by AI systems). A fourth idea from the original proposal — judging
whether the sentence after an `<h2>` is a direct answer vs. "fluff" — was
dropped: that's a real semantic judgment call, and a naive heuristic for it
(question words, hedging phrases, sentence length) would produce enough
false positives/negatives to undermine trust in the signal rather than add
value. Kept to things reliably measurable from the DOM alone instead.

This is explicitly **not** part of the cahier de charge's 100-point score —
it's a separate `ragReadiness` field on the result, rendered in its own
clearly-labeled "Bonus — hors score" section, and there's a dedicated test
(`ragReadiness never affects the official score, regardless of how bad it
looks`) asserting that a page with every RAG signal failing produces an
identical score to a clean page. This was a deliberate line not to cross:
the official scoring formula has been kept exactly matching the spec since
Week 1, with every deviation explicitly documented (FID→INP, the CLS
double-counting note, etc.) — silently adding new penalty types on top of
that, even well-intentioned ones, would blur the line between "implements
the spec" and "implements the spec plus whatever seemed like a good idea,"
which isn't a line worth blurring on a graded deliverable.

**Added optional Google AI Overview citation tracking via SerpApi — also
hors score.** The audit form now has a GEO checkbox and an optional
"target queries" textarea. When enabled, `src/geo/citations.js` sends up to
5 sequential queries to SerpApi's Google Search API, follows the documented
`ai_overview.page_token` / `google_ai_overview` second request when needed,
extracts citation URLs from `ai_overview.references[].link` plus nested
URL-like `source` fields, and reports whether the audited domain (including
subdomains) is cited. User-provided queries are preferred; if the textarea
is empty, the tool derives a few fallback queries from crawled page titles.
The results are saved inside the existing report JSON, so `/report/:id`
remains reloadable.

This feature is deliberately opt-in because every query consumes SerpApi
quota, and it requires a private API key. Create a local `.env` file in the
project root:

```env
SERPAPI_KEY=your_key_here
```

Then start the app normally:

```bash
npm start
```

You can still use a one-off PowerShell environment variable instead:

```powershell
$env:SERPAPI_KEY = "your_key_here"
npm start
```

If the checkbox is enabled without `SERPAPI_KEY`, the report shows a
clear "SerpApi non configure" note instead of failing the audit. I could
only verify the integration with mocked/local logic in this environment
because no real key is available here; the response shape was checked
against SerpApi's current official AI Overview docs.

**A later SerpApi debugging pass found a subtle two-request key bug.** The
symptom was confusing: SerpApi's dashboard showed searches being consumed,
so the API key clearly worked, but the report still displayed
`SerpApi AI Overview follow-up request failed (401): Invalid API key`.
The reason was the two-step AI Overview flow. The first `engine=google`
request used the configured `SERPAPI_KEY` and succeeded, which counted as a
search. But when that response included `ai_overview.page_token`, the code
trusted SerpApi's returned `serpapi_link` directly for the second
`engine=google_ai_overview` request. That follow-up URL can arrive without
an `api_key`, or with a stale/placeholder one, so only the second request
failed.

Fixed in `src/geo/citations.js` by rewriting any provided follow-up URL
through `withSerpApiKey()`, which always injects the currently configured
key before making the request. While touching the module, SerpApi responses
were also made less opaque: if the API returns a JSON `error`, the report
now surfaces that message instead of only saying "failed (401)" or "failed
(500)". Added regression tests for injecting a missing key, replacing a
stale key, following `page_token`, and preserving the AI Overview-only
`json_restrictor=ai_overview` request shape.

**A small UX complaint turned up a real architecture gap: results weren't
a real page.** The category drill-down page only had a "Nouvel audit"
button — no way back to the results just seen, and no way to jump between
categories without going back through results each time. The actual cause:
`POST /audit` rendered `results.ejs` directly as the response body, so
there was never a stable, reloadable URL for it — nothing to link back to.
Fixed properly rather than patched around: `POST /audit` now saves the
run and redirects (302) to `GET /report/:id`, which is the real results
page — reloadable, linkable, bookmarkable. The SQLite schema was extended
to store the *entire* `scoreResult` (not just `categoryDetails` as before)
plus `browserResults` as JSON, which is what makes reconstructing the full
results page from just an id possible. The crawled `pages` array itself is
deliberately NOT stored — `results.ejs` only ever reads `pages.length`,
already captured by the existing `pages_crawled` column, so storing the
full array would've been pure overhead. `category.ejs` now has a
"Retour aux résultats" button (linking to `/report/:id`) and a row of tabs
for all five categories, so switching from one category's problems to
another's is one click instead of a round trip through results each time.
Verified through real HTTP requests end to end: audit → redirect → results
→ category → tab-switch to a different category → back button — all
followed and confirmed, not just written and assumed.

**Encadrant feedback round — four requests, all addressed:**

1. *"Le délai d'expiration maximal est trop court (20 pages seulement)."*
   The crawl-level deadline (added in Week 5 as a robustness guard) was
   defaulting to 60 seconds — reasonable for a demo, too short for a real
   audit. Raised to 15 minutes as requested.

2. *"Lorsqu'on clique sur une catégorie, on souhaite afficher une page
   listant toutes les pages concernées."* This needed real architecture,
   not a styling tweak: every issue in `auditScoring.js` now carries a
   stable `code` (not just human-readable `text`, which embeds dynamic
   values like counts and can't be matched reliably). On-page/mobile/
   performance issues are naturally per-page already, so they're tagged
   with their source URL directly; crawlability/technical issues are
   computed once site-wide, so `buildAuditData.js` re-derives affected
   pages from the same conditions that trigger each penalty (e.g.
   `missing_canonical` → pages where `!page.canonical`). Genuinely
   site-wide checks (SSL, robots.txt, sitemap) are labeled as such rather
   than forced into a page list that wouldn't make sense. Issues are then
   grouped by code, merging duplicates across pages into one entry with a
   combined page list — a real change from before, where the same problem
   on 5 pages meant 5 separate identical-looking rows in the issues table.
   The category cards are now links to a new route
   (`GET /report/:id/category/:key`), which needed the SQLite schema
   extended to store full category detail as JSON (`details_json` column,
   with a defensive `ALTER TABLE` for upgrading an existing local db file)
   so the drill-down page is a real, reloadable URL rather than a
   client-side-only view.

3. *"Agrandir les points de la courbe statistique."* Sparkline dots went
   from `r="3"` to `r="6"` with a white outline for contrast — confirmed
   in a re-render, not just assumed from the CSS.

4. *"Ajouter les indicateurs de performance (LCP, TTFB, CLS) avec un code
   couleur."* Added, plus INP as a bonus since the same `browserResults`
   data already carries it. Color thresholds match the ones already
   driving the score (LCP >4s/2.5-4s, TTFB >600ms/300-600ms — the cahier
   de charge's own numbers) rather than introducing a second, different
   set of thresholds that would silently disagree with the score. CLS and
   INP bands use the standard Core Web Vitals "needs improvement" tiers
   for the same reason the scoring engine already does — the cahier de
   charge only defines a single cutoff for these two, but three color
   bands needed a sensible middle value. Verified by rendering with
   synthetic data spanning all three bands and confirming the colors
   actually differ.

Also done in this round: full French pass on `results.ejs` (severity
labels — WARNING/CRITICAL/NOTICE — were still displaying in English; now
Avertissement/Critique/Remarque, with the underlying English codes kept
internally for CSS classes and JS filtering so nothing broke), and both
action buttons (Nouvel audit / Télécharger le rapport) restyled to match a
reference screenshot — solid blue, rounded, consistent treatment for both
instead of two different visual styles.

**Second encadrant feedback round - duplicate reporting and SEO length
rules.** A real audit of darbooking.com exposed two problems that were easy
to miss with small mocked fixtures. First, URLs that only differed by query
parameters were treated as separate pages: for example
`/vols-search?flightSearch=A` and `/vols-search?flightSearch=B` were both
crawled, scored, and displayed as if they were independent pages. That
created enormous duplicate-title / duplicate-description lists even though,
from the audit's point of view, the page template is the same. Fixed at two
levels: `crawler.js` now uses a query-less page identity for visited/enqueue
checks, and `buildAuditData.js` also collapses already-collected pages by
the same canonical page URL before counting duplicates. This second guard
matters for older saved data and for any future caller that passes raw page
arrays directly into scoring.

Second, the title-length rule was too strict for the current validation
criteria. The previous implementation penalized titles below 30 characters
and above 60 characters. The encadrant clarified the intended rule: title
maximum 70 characters, meta-description maximum 160 characters. So a title
like `Plan du site - Darbooking` (25 characters) should not be flagged at
all. `auditScoring.js` now only penalizes `metaTitleLength > 70` and
`metaDescriptionLength > 160`, with no lower-bound penalty for either field.

The category detail UI was also changed to match the requested duplicate
reporting format. Instead of one huge card containing every affected URL,
`category.ejs` now renders duplicate titles/descriptions as a table: one row
per duplicated value, with the affected URLs grouped beside that exact
title or description. This makes it clear which pages share which value,
and avoids visually mixing unrelated duplicates into one unreadable list.
Verified with new regression tests for query-parameter collapsing, short
title acceptance, max-length enforcement, duplicate-group data, and an EJS
render smoke test confirming the duplicate table is actually produced.

**Third encadrant feedback round - long crawls need background jobs before
homepage statistics.** The 4,000-page request exposed an architectural
problem rather than a pure crawler problem. Internally, the crawler loop is
linear and already uses a visited set, batching, per-request timeouts, and a
crawl-level deadline, so there is no obvious quadratic bottleneck in the
crawling algorithm itself. The fragile part was the HTTP lifecycle:
`POST /audit` used to do the entire crawl, browser sample, GEO checks,
scoring, SQLite save, and redirect inside one request. For a large content
site, that means the browser tab is waiting on a single long-running
request for many minutes. Closing the tab, cancelling the loading screen,
or later interacting with homepage history/modals would all be tied to that
same request/response flow.

Fixed first as infrastructure, deliberately before building the homepage
history/statistics UI. `server.js` now starts an in-memory background job
from `POST /audit` and immediately returns `202 Accepted` with a
`statusUrl`. The actual crawl continues server-side in `runAuditJob()`, then
saves the finished report and attaches `/report/:id` to the job once it is
complete. A new `GET /audit/jobs/:id` endpoint exposes `queued` / `running`
/ `completed` / `failed` state plus the report URL, so the front end can
poll instead of holding one giant request open.

The loading screen in `index.ejs` was adjusted to use that polling model.
Submitting the audit form now shows "Audit en cours", starts the job, polls
`/audit/jobs/:id`, and redirects only when the job returns a report URL. The
button is intentionally labelled `Annuler l'attente`: it stops the browser
from waiting and hides the loading view, but it does not kill the server-side
crawl. That matches the encadrant's requirement that user interaction should
not interrupt an audit already running in the background. The chosen job
store is intentionally lightweight and in-memory, proportional to this
project's scope; it survives normal page navigation and UI interaction, but
not a Node server restart. Verified with `tests/serverJobs.test.js`, which
starts a real local target site, posts to `/audit`, receives a `202`, polls
the status endpoint, and confirms the job eventually produces a real
`/report/:id`.

**A pre-existing dead-code bug was found and fixed while touching this
code**: `buildOnPageDataForPage`'s duplicate-content wiring compared
`data === htmlPages[0]` — comparing a freshly-built data object to a raw
page object, which can never be true regardless of which page it is. The
`duplicateContentPageCount` parameter has therefore never actually applied
to any page's scoring in practice. Fixed to compare the actual page
(`p === htmlPages[0]`). Not currently exercised by any caller (nothing
passes a non-zero `duplicateContentPageCount` yet — that's still on the
list from the original near-duplicate-content-detection gap noted back in
the crawler-testing phase), so this had no visible effect until now, but
worth knowing about.

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

**A real "Audit failed: The operation was aborted." crash was found after
testing against several live sites.** The original request-level timeout
handling looked complete because `fetchOne()` caught aborted fetches, but
there was a second place an abort can happen: after headers arrive, while
`resp.text()` is still reading the HTML body. That body-read error escaped
`processPage()`, bubbled all the way up to `POST /audit`, and killed the
entire run even though the crawler could have safely recorded that single
page as failed and continued.

Fixed in `src/crawler/crawler.js`: HTML body reading is now wrapped in a
local `try/catch`; if it aborts, the page keeps its URL/status/response
time and gets an `error` message, but extraction is skipped for that page
instead of throwing away the whole report. Verified with a targeted
regression test that forces `resp.text()` to throw `"The operation was
aborted."`, plus a real Express-route smoke test where `POST /audit` against
`https://example.com` completed normally and redirected to `/report/:id`.

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
