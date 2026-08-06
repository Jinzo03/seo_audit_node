const cheerio = require('cheerio');
const extract = require('./extract');
const { fetchRobots, isAllowed } = require('./robots');
const { parseSitemapXml } = require('./sitemap');
const { hasHsts, hasAnySecurityHeader } = require('./securityHeaders');
const { detectMixedContent } = require('./mixedContent');
const { checkCertificate } = require('./tlsCheck');

const USER_AGENT = 'SimpleSEOAuditBot/1.0 (+internship project)'; // sent in HTTP headers
const ROBOTS_TOKEN = 'SimpleSEOAuditBot'; // bare name for robots.txt matching

class Crawler {
  constructor(startUrl, options = {}) {
    const {
      maxPages = 20,
      concurrency = 5,
      timeoutMs = 10000,
      delayMs = 0,
      maxRedirects = 10,
      crawlTimeoutMs = 60000,
      maxPageSizeBytes = 5 * 1024 * 1024,
    } = options;

    this.startUrl = startUrl.replace(/\/$/, '');
    const parsed = new URL(this.startUrl);
    this.domain = parsed.host;
    this.scheme = parsed.protocol.replace(':', '');

    this.maxPages = maxPages;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.delayMs = delayMs;
    this.maxRedirects = maxRedirects;
    this.crawlTimeoutMs = crawlTimeoutMs;
    this.maxPageSizeBytes = maxPageSizeBytes;
    this.crawlTimedOut = false;

    this.visited = new Set();
    this.queue = [];
    this.results = [];
    this.robots = null;
    this._robotsLoaded = false;
  }

  // ------------------------------------------------------------------
  // Pure helpers
  // ------------------------------------------------------------------

  sameDomain(url) {
    try {
      return new URL(url).host === this.domain;
    } catch (err) {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Duplicate detection / queue management
  // ------------------------------------------------------------------

  markVisited(url) {
    if (this.visited.has(url)) return false;
    this.visited.add(url);
    return true;
  }

  shouldEnqueue(url) {
    return !this.visited.has(url) && this.sameDomain(url) && this.isAllowed(url);
  }

  // ------------------------------------------------------------------
  // robots.txt
  // ------------------------------------------------------------------

  async ensureRobotsLoaded() {
    if (this._robotsLoaded) return;
    this.robots = await fetchRobots(this.scheme, this.domain, USER_AGENT, this.timeoutMs);
    this._robotsLoaded = true;
  }

  isAllowed(url) {
    return isAllowed(this.robots, url, ROBOTS_TOKEN);
  }

  // ------------------------------------------------------------------
  // Fetching (rate limiting lives here — delay applied after each
  // request, mirroring the concurrency-slot-release timing used in the
  // Python version)
  // ------------------------------------------------------------------

  // Redirects are followed manually (redirect: 'manual') instead of letting
  // fetch auto-follow them, specifically so we can count hops and detect
  // loops — auto-follow only ever hands back the final response, with no
  // visibility into how it got there.
  async fetchOne(url) {
    const start = Date.now();
    let resp = null;
    let error = null;
    let hops = 0;
    let loopDetected = false;
    let currentUrl = url;
    const visitedInChain = new Set([url]);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await fetch(currentUrl, {
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const isRedirect = r.status >= 300 && r.status < 400;
        const location = isRedirect && r.headers && typeof r.headers.get === 'function'
          ? r.headers.get('location')
          : null;

        if (!location) {
          resp = r; // final, non-redirect response (or a redirect with no Location — treat as final)
          break;
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch (err) {
          resp = r; // malformed Location header — stop here rather than crash
          break;
        }

        hops += 1;

        if (visitedInChain.has(nextUrl)) {
          loopDetected = true;
          resp = r;
          break;
        }
        if (hops >= this.maxRedirects) {
          resp = r; // safety cap — too many hops, stop following
          break;
        }

        visitedInChain.add(nextUrl);
        currentUrl = nextUrl;
      }
    } catch (err) {
      error = err.message;
    }
    const elapsedMs = Date.now() - start;

    if (this.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    return { resp, elapsedMs, error, redirectHops: hops, redirectLoopDetected: loopDetected };
  }

  // Runs fetchOne over a list of URLs, capping concurrency by chunking
  // instead of running everything at once — equivalent in effect to the
  // Python version's asyncio.Semaphore.
  async fetchWithConcurrencyCap(urls) {
    const outputs = [];
    for (let i = 0; i < urls.length; i += this.concurrency) {
      const chunk = urls.slice(i, i + this.concurrency);
      const chunkResults = await Promise.all(chunk.map((url) => this.fetchOne(url)));
      outputs.push(...chunkResults);
    }
    return outputs;
  }

  // ------------------------------------------------------------------
  // Page processing
  // ------------------------------------------------------------------

  async processPage(url, resp, elapsedMs, error) {
    const data = {
      url,
      statusCode: resp ? resp.status : null,
      responseTimeMs: elapsedMs,
      error,
      linksFound: [],
    };

    const contentType = resp ? resp.headers.get('content-type') || '' : '';
    if (!resp || !contentType.includes('text/html')) {
      return data;
    }

    data.hstsPresent = hasHsts(resp.headers);
    data.securityHeadersPresent = hasAnySecurityHeader(resp.headers);

    const html = await resp.text();

    if (Buffer.byteLength(html, 'utf8') > this.maxPageSizeBytes) {
      data.pageTooLarge = true;
      data.pageSizeBytes = Buffer.byteLength(html, 'utf8');
      return data; // skip full parsing — not worth the memory/CPU cost, and
      // a page this large is unusual enough to flag rather than analyze
    }

    return this.extractPageData(data, html, url);
  }

  // Split out from processPage so tests can feed raw HTML directly
  // without needing a real fetch Response object.
  extractPageData(data, html, url) {
    const $ = cheerio.load(html);

    data.title = extract.extractTitle($);
    data.metaDescription = extract.extractMetaDescription($);

    const h1 = extract.extractH1($);
    data.h1Count = h1.count;
    data.h1Text = h1.text;

    const heading = extract.checkHeadingHierarchy($);
    data.brokenHeadingHierarchy = heading.brokenHierarchy;

    data.canonical = extract.extractCanonical($);
    data.metaRobots = extract.extractMetaRobots($);
    data.hasViewport = extract.extractViewport($);

    const images = extract.extractImages($);
    data.imageCount = images.count;
    data.imagesMissingAlt = images.missingAlt;

    const text = extract.extractText($);
    data.wordCount = extract.wordCount(text);
    data.contentHash = extract.contentHash(text);
    data.possibleSpa = extract.detectPossibleSpa($, data.wordCount);

    data.structuredDataRaw = extract.extractStructuredData($);
    data.isHttps = url.startsWith('https://');
    data.mixedContent = detectMixedContent($, url);

    const links = extract.extractLinks($, url);
    data.linksFound = links;
    data.internalLinks = links.filter((l) => this.sameDomain(l)).length;
    data.externalLinks = links.length - data.internalLinks;

    return data;
  }

  // ------------------------------------------------------------------
  // Crawl orchestration
  // ------------------------------------------------------------------

  async crawl() {
    this.queue.push(this.startUrl);
    this.markVisited(this.startUrl);

    await this.ensureRobotsLoaded();

    const deadline = Date.now() + this.crawlTimeoutMs;

    while (this.queue.length > 0 && this.results.length < this.maxPages) {
      if (Date.now() >= deadline) {
        this.crawlTimedOut = true;
        break; // return whatever was collected rather than hang indefinitely
      }

      const batch = this.dequeueBatch();
      const fetched = await this.fetchWithConcurrencyCap(batch);

      for (let i = 0; i < batch.length; i += 1) {
        const url = batch[i];
        const { resp, elapsedMs, error, redirectHops, redirectLoopDetected } = fetched[i];
        const pageData = await this.processPage(url, resp, elapsedMs, error);
        pageData.redirectHops = redirectHops;
        pageData.redirectLoopDetected = redirectLoopDetected;
        this.results.push(pageData);
        this.discoverLinks(pageData, resp);
      }
    }

    return this.results;
  }

  dequeueBatch(batchSize = 10) {
    const batch = [];
    while (
      this.queue.length > 0
      && batch.length < batchSize
      && this.results.length + batch.length < this.maxPages
    ) {
      batch.push(this.queue.shift());
    }
    return batch;
  }

  discoverLinks(pageData, resp) {
    const contentType = resp ? resp.headers.get('content-type') || '' : '';
    if (!resp || !contentType.includes('text/html')) return;

    for (const link of pageData.linksFound) {
      if (this.shouldEnqueue(link) && this.visited.size < this.maxPages * 3) {
        this.markVisited(link);
        this.queue.push(link);
      }
    }
  }

  // ------------------------------------------------------------------
  // Sitemap checking
  // ------------------------------------------------------------------

  async checkSitemap(maxUrls = 50) {
    const sitemapUrl = `${this.scheme}://${this.domain}/sitemap.xml`;
    const result = {
      sitemapUrl,
      found: false,
      isIndex: false,
      urlCount: 0,
      brokenUrls: [],
      error: null,
    };

    let resp;
    try {
      resp = await fetch(sitemapUrl, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      result.error = `Could not fetch sitemap.xml: ${err.message}`;
      return result;
    }

    if (resp.status >= 400) {
      result.error = `sitemap.xml returned status ${resp.status}`;
      return result;
    }

    result.found = true;

    let parsed;
    try {
      const text = await resp.text();
      parsed = parseSitemapXml(text);
    } catch (err) {
      result.error = `sitemap.xml is not valid XML: ${err.message}`;
      return result;
    }

    result.isIndex = parsed.isIndex;
    let urls = parsed.urls;

    if (parsed.isIndex) {
      const nestedUrls = [];
      for (const subUrl of urls.slice(0, 5)) {
        try {
          const subResp = await fetch(subUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          const subText = await subResp.text();
          const nested = parseSitemapXml(subText);
          nestedUrls.push(...nested.urls);
        } catch (err) {
          // skip unreachable sub-sitemap, keep going
        }
      }
      urls = nestedUrls;
    }

    urls = urls.slice(0, maxUrls);
    result.urlCount = urls.length;

    const fetched = await this.fetchWithConcurrencyCap(urls);
    for (let i = 0; i < urls.length; i += 1) {
      const { resp: pageResp, error } = fetched[i];
      const status = pageResp ? pageResp.status : null;
      if (error || status === null || status >= 400) {
        result.brokenUrls.push({ url: urls[i], status, error });
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // SSL certificate check (site-level — a certificate covers the whole
  // domain, so this runs once, not per crawled page)
  // ------------------------------------------------------------------

  async checkSsl() {
    if (this.scheme !== 'https') {
      return { checked: false, valid: false, reason: 'Site is not served over HTTPS' };
    }
    const hostname = this.domain.split(':')[0]; // strip a port if present
    return checkCertificate(hostname, { timeoutMs: this.timeoutMs });
  }
}

module.exports = { Crawler, USER_AGENT, ROBOTS_TOKEN };