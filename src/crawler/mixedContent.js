/**
 * A page served over HTTPS that loads any sub-resource over plain HTTP is a
 * real security downgrade (browsers block or warn about it). Detected by
 * scanning the HTML we've already parsed with Cheerio — no extra requests.
 */
function detectMixedContent($, pageUrl) {
  if (!pageUrl || !pageUrl.startsWith('https://')) return false; // only relevant on HTTPS pages

  const targets = [
    { selector: 'img', attr: 'src' },
    { selector: 'script', attr: 'src' },
    { selector: 'link[rel="stylesheet"]', attr: 'href' },
    { selector: 'iframe', attr: 'src' },
  ];

  for (const { selector, attr } of targets) {
    let found = false;
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (value && value.trim().toLowerCase().startsWith('http://')) {
        found = true;
      }
    });
    if (found) return true;
  }

  return false;
}

module.exports = { detectMixedContent };
