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

function detectPossibleSpa($) {
  // Heuristic: if the page has no <h1> and no <title>, it might be a SPA.
  const hasH1 = $('h1').length > 0;
  const hasTitle = $('title').length > 0;
  return !hasH1 && !hasTitle;
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
  detectPossibleSpa
};
