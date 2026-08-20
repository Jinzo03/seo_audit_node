/**
 * Checks whether the audited site is cited as a source in Google's AI
 * Overview for a set of queries — a direct measure of GEO/AI-search
 * visibility, via SerpApi (https://serpapi.com).
 *
 * STATUS: written against SerpApi's documented response shape, but NOT
 * verified against a live key — this sandbox has no SerpApi key, and
 * serpapi.com isn't reachable from it anyway (outside the network
 * allowlist this environment was built in). The extraction logic below is
 * deliberately defensive (walks the whole ai_overview object collecting
 * every `link` field, rather than hardcoding one exact path) specifically
 * because the precise field name for citations wasn't 100% certain from
 * documentation alone. Test with a real key before trusting this:
 *
 *   SERPAPI_KEY=your_key node -e "
 *     require('./src/geo/citations').checkCitations(['your test query'], 'example.com', process.env.SERPAPI_KEY)
 *       .then(r => console.log(JSON.stringify(r, null, 2)))
 *   "
 *
 * If the real response shape differs from what's assumed here, the fix is
 * almost certainly isolated to extractAllLinksFromAiOverview() below —
 * paste the actual JSON response and it's a small, contained change.
 */

const SERPAPI_BASE = 'https://serpapi.com/search.json';

function buildSerpApiUrl(params) {
  const url = new URL(SERPAPI_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function withSerpApiKey(url, apiKey) {
  const parsed = new URL(url);
  parsed.searchParams.set('api_key', apiKey);
  return parsed.toString();
}

async function parseSerpApiResponse(resp, label) {
  let data = null;
  let text = '';

  try {
    text = await resp.text();
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = null;
  }

  const apiError = data && typeof data.error === 'string' ? data.error : null;
  if (!resp.ok || apiError) {
    const detail = apiError || (text ? text.slice(0, 200) : resp.statusText);
    throw new Error(`${label} failed (${resp.status}): ${detail}`);
  }

  return data || {};
}

/**
 * Fetches Google's AI Overview for one query, handling the two-step flow
 * SerpApi uses when the overview needs a follow-up call (page_token).
 * Returns null if there's simply no AI Overview for this query — common,
 * not every query triggers one, and that's not an error condition.
 */
async function fetchAiOverview(query, apiKey, options = {}) {
  const {
    timeoutMs = 15000,
    hl = 'en',
    gl = 'us',
    noCache = true,
  } = options;

  const searchUrl = buildSerpApiUrl({
    engine: 'google',
    q: query,
    api_key: apiKey,
    hl,
    gl,
    json_restrictor: 'ai_overview',
    no_cache: noCache ? 'true' : undefined,
  });
  const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(timeoutMs) });
  const data = await parseSerpApiResponse(resp, 'SerpApi search request');

  if (!data.ai_overview) return null;

  if (data.ai_overview.page_token) {
    const followUrl = data.ai_overview.serpapi_link
      ? withSerpApiKey(data.ai_overview.serpapi_link, apiKey)
      : buildSerpApiUrl({
        engine: 'google_ai_overview',
        page_token: data.ai_overview.page_token,
        api_key: apiKey,
        no_cache: noCache ? 'true' : undefined,
      });
    const followResp = await fetch(followUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const followData = await parseSerpApiResponse(followResp, 'SerpApi AI Overview follow-up request');
    return followData.ai_overview || null;
  }

  return data.ai_overview;
}

/**
 * Recursively collects every `link` field found anywhere inside an
 * ai_overview object, regardless of exact nesting (references array,
 * text_blocks list items, etc.) — deliberately schema-tolerant rather than
 * hardcoding one exact path, since the precise shape wasn't confirmed
 * against a live response.
 */
function extractCitationLinksFromAiOverview(aiOverview) {
  const links = new Set();

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.link === 'string') links.add(node.link);
      if (typeof node.source === 'string' && /^https?:\/\//i.test(node.source)) links.add(node.source);
      Object.values(node).forEach(walk);
    }
  }

  walk(aiOverview);
  return Array.from(links);
}

/**
 * Whether a URL belongs to the target domain (or a subdomain of it) —
 * e.g. blog.example.com counts as a citation of example.com.
 */
function isDomainMatch(link, domain) {
  try {
    const linkHost = new URL(link).hostname.replace(/^www\./, '').toLowerCase();
    const targetHost = domain.replace(/^www\./, '').toLowerCase();
    return linkHost === targetHost || linkHost.endsWith(`.${targetHost}`);
  } catch (err) {
    return false;
  }
}

/**
 * Runs each query sequentially (not in parallel — gentle on rate limits,
 * and free-tier quota is precious) and reports whether the target domain
 * was cited in that query's AI Overview.
 */
async function checkCitations(queries, domain, apiKey, options = {}) {
  const { delayMs = 500, timeoutMs = 15000, hl = 'en', gl = 'us' } = options;
  const results = [];

  for (const query of queries) {
    try {
      const aiOverview = await fetchAiOverview(query, apiKey, { timeoutMs, hl, gl });
      if (!aiOverview) {
        results.push({
          query, hasAiOverview: false, cited: false, citedUrl: null, citationUrls: [], error: null,
        });
      } else {
        const links = extractCitationLinksFromAiOverview(aiOverview);
        const selfCitations = links.filter((link) => isDomainMatch(link, domain));
        const competitorCitations = links.filter((link) => !isDomainMatch(link, domain));
        const citedLink = selfCitations[0] || null;

        results.push({
          query,
          hasAiOverview: true,
          cited: Boolean(citedLink),
          citedUrl: citedLink || null,
          citationUrls: links,
          selfCitations,
          competitorCitations,
          error: null,
        });
      }
    } catch (err) {
      results.push({
        query, hasAiOverview: false, cited: false, citedUrl: null, citationUrls: [], error: err.message,
      });
    }

    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Coarse query-derivation fallback: uses crawled page titles as a proxy
 * for "what this page might be trying to rank for". User-supplied queries
 * (from the audit form) are always preferred when available — this is
 * only a fallback so the feature still does something useful if the user
 * leaves the query field blank.
 */
function deriveQueriesFromPages(pages, maxQueries = 3) {
  const seen = new Set();
  const queries = [];
  for (const page of pages) {
    const title = (page.title || '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    queries.push(title);
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

/**
 * Merges user-supplied queries with auto-derived ones (as filler, only if
 * the user didn't already provide enough), capped at maxTotal to bound API
 * cost per audit.
 */
function buildQueryList(userQueries, pages, options = {}) {
  const { maxTotal = 5, maxAuto = 3 } = options;

  const cleaned = (userQueries || [])
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, maxTotal);

  if (cleaned.length >= maxTotal) return cleaned;

  const remainingSlots = maxTotal - cleaned.length;
  const auto = deriveQueriesFromPages(pages, Math.min(remainingSlots, maxAuto));

  const merged = [...cleaned];
  for (const q of auto) {
    if (merged.length >= maxTotal) break;
    if (!merged.includes(q)) merged.push(q);
  }
  return merged;
}

async function runCitationAudit({
  requested,
  userQueries,
  pages,
  domain,
  apiKey = process.env.SERPAPI_KEY,
  options = {},
}) {
  if (!requested) {
    return { status: 'not_requested', targetDomain: domain, queries: [], results: [], summary: null };
  }

  const queries = buildQueryList(userQueries, pages, options);

  if (!apiKey) {
    return {
      status: 'missing_key',
      targetDomain: domain,
      queries,
      results: [],
      summary: null,
    };
  }

  if (queries.length === 0) {
    return {
      status: 'no_queries',
      targetDomain: domain,
      queries: [],
      results: [],
      summary: null,
    };
  }

  const results = await checkCitations(queries, domain, apiKey, options);
  const summary = {
    checked: results.length,
    cited: results.filter((r) => r.cited).length,
    withAiOverview: results.filter((r) => r.hasAiOverview).length,
    errors: results.filter((r) => r.error).length,
  };

  return {
    status: 'ok',
    targetDomain: domain,
    queries,
    results,
    summary,
  };
}

module.exports = {
  fetchAiOverview,
  withSerpApiKey,
  parseSerpApiResponse,
  extractCitationLinksFromAiOverview,
  extractAllLinksFromAiOverview: extractCitationLinksFromAiOverview,
  isDomainMatch,
  checkCitations,
  deriveQueriesFromPages,
  buildQueryList,
  runCitationAudit,
};
