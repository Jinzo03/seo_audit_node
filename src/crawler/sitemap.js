const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser();

// fast-xml-parser collapses a single repeated element to an object instead
// of a one-item array — normalize so callers always get an array.
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse raw sitemap XML text. Returns { isIndex, urls }.
 * Throws if the XML is malformed or has neither <urlset> nor <sitemapindex>.
 */
function parseSitemapXml(xmlText) {
  const parsed = parser.parse(xmlText);

  if ('sitemapindex' in parsed) {
    const node = parsed.sitemapindex;
    const entries = typeof node === 'object' ? asArray(node.sitemap) : [];
    const urls = entries.map((entry) => entry.loc).filter(Boolean);
    return { isIndex: true, urls };
  }

  if ('urlset' in parsed) {
    const node = parsed.urlset;
    const entries = typeof node === 'object' ? asArray(node.url) : [];
    const urls = entries.map((entry) => entry.loc).filter(Boolean);
    return { isIndex: false, urls };
  }

  throw new Error('Not a recognizable sitemap (no <urlset> or <sitemapindex> root)');
}

module.exports = { parseSitemapXml, asArray };
