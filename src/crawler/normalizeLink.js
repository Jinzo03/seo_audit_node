/**
 * Resolve href against baseUrl into an absolute http(s) URL.
 * Returns null for non-navigable links (empty, mailto:, tel:, javascript:,
 * pure fragments) instead of a URL, so callers can filter with a simple
 * truthiness check.
 */

function normalizeLink(baseUrl, href) {
    if (!href) return null;
    href = href.trim();
    if (!href || /^(mailto:|javascript:|tel:|#)/i.test(href)) return null;

    const withoutFragment = href.split('#')[0];
    if (!withoutFragment) return null;

    let absolute;
    try {
        absolute = new URL(withoutFragment, baseUrl).toString();
    } catch (err) {
      return null; //malformed href
    }

    if (!/^https?:\/\//i.test(absolute)) return null;
    return absolute;
}

module.exports = { normalizeLink };
