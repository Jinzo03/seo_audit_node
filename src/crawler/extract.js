const crypto = require('crypto');
const { normalizeLink } = require('./normalizeLink');

function extractTitle($) {
  const text = $('title').first().text().trim();
  return text.length ? text : null;
}

function extractMetaDescription($) {
  const content = $('meta[name="description"]').first().attr('content');
  return content ? content.trim() : null;
}

function extractH1($) {
  const h1s = $('h1');
  const count = h1s.length;
  const text = count > 0 ? $(h1s[0]).text().trim() : null;
  return { count, text };
}

// H2/H3 hierarchy check from the cahier de charge: flag H1 -> H3 with no H2 in between.
function checkHeadingHierarchy($) {
  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    headings.push(el.tagName.toLowerCase());
  });
  let brokenHierarchy = false;
  let lastLevel = 0;
  for (const tag of headings) {
    const level = parseInt(tag[1], 10);
    if (level - lastLevel > 1) {
      brokenHierarchy = true;
      break;
    }
    lastLevel = level;
  }
  return { brokenHierarchy, h1Count: headings.filter((h) => h === 'h1').length };
}

function extractCanonical($) {
  const href = $('link[rel="canonical"]').first().attr('href');
  return href || null;
}

function extractMetaRobots($) {
  const content = $('meta[name="robots"]').first().attr('content');
  return content || null;
}

function extractViewport($) {
  return $('meta[name="viewport"]').length > 0;
}

function extractImages($) {
  const images = $('img');
  let missingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    if (!alt) missingAlt += 1;
  });
  return { count: images.length, missingAlt };
}

function extractText($) {
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function contentHash(text) {
  if (!text) return null;
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function extractStructuredData($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const content = $(el).contents().text();
    if (content && content.trim()) blocks.push(content);
  });
  return blocks;
}

function extractLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const normalized = normalizeLink(baseUrl, href);
    if (normalized) links.push(normalized);
  });
  return links;
}

// Common containers that JS frameworks mount into. Their presence alongside
// very little actual text is a strong signal the real content only exists
// after JavaScript runs — which this crawler (fetch + Cheerio) never does.
// This isn't a scoring rule from the cahier de charge; it's an honest
// disclosure that "thin content" or "missing title" findings on a page
// like this may just be an artifact of the crawler's own limitation, not a
// real SEO problem with the site.
const SPA_ROOT_SELECTORS = ['#root', '#app', '#__next', '#__nuxt', '[data-reactroot]', '[ng-version]'];

function detectPossibleSpa($, wordCount) {
  if (wordCount >= 50) return false; // enough real text to not be a rendering artifact
  return SPA_ROOT_SELECTORS.some((selector) => {
    try {
      return $(selector).length > 0;
    } catch (err) {
      return false;
    }
  });
}

// --------------------------------------------------------------------
// RAG / GEO readiness signals — NOT part of the cahier de charge's
// 100-point score. AI answer engines (ChatGPT, Perplexity, Google AI
// Overviews) break pages into chunks to extract answers; these checks
// estimate how well a page is formatted for that, as a separate bonus
// insight, not a scored category. Kept deliberately simple (word counts,
// tag presence, schema @type checks) rather than any real NLP — a
// semantic "is this the bottom-line-first sentence" judgment call would
// produce enough false positives to undermine trust in the signal, so
// that idea was deliberately dropped in favor of things measurable
// reliably from the DOM alone.

const MAX_PARAGRAPH_WORDS = 300;
const AI_FRIENDLY_SCHEMA_TYPES = ['FAQPage', 'HowTo', 'QAPage'];

// Paragraphs over ~300 words are harder for an LLM to cleanly extract a
// single answer from — flags how many such paragraphs are on the page.
function countLongParagraphs($) {
  let count = 0;
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text && wordCount(text) > MAX_PARAGRAPH_WORDS) count += 1;
  });
  return count;
}

// Lists and tables are extracted cleanly by AI systems (structured,
// unambiguous) compared to prose — their presence is a positive signal.
function hasListsOrTables($) {
  return $('ul, ol, table').length > 0;
}

// FAQPage/HowTo/QAPage structured data is exactly the shape AI answer
// engines are built to consume directly. Operates on the already-parsed
// structuredDataRaw strings rather than re-parsing the DOM.
function detectAiFriendlySchema(structuredDataRaw) {
  for (const raw of structuredDataRaw || []) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      continue; // invalid JSON — already flagged elsewhere as a structured data error
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (types.some((t) => AI_FRIENDLY_SCHEMA_TYPES.includes(t))) return true;
    }
  }
  return false;
}

module.exports = {
  extractTitle,
  extractMetaDescription,
  extractH1,
  checkHeadingHierarchy,
  extractCanonical,
  extractMetaRobots,
  extractViewport,
  extractImages,
  extractText,
  wordCount,
  contentHash,
  extractStructuredData,
  extractLinks,
  detectPossibleSpa,
  countLongParagraphs,
  hasListsOrTables,
  detectAiFriendlySchema,
};