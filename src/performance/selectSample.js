/**
 * Running a real browser pass (Playwright) on every crawled page is slow —
 * multiple seconds per page vs. milliseconds for the httpx/Cheerio pass —
 * so instead of auditing every page, we sample a representative subset,
 * the same way commercial audit tools do.
 *
 * Strategy: always include the homepage (most representative of the site's
 * templates/assets), then fill the rest of the sample with pages spread
 * evenly across the crawl order rather than just the first N pages. The
 * crawl is breadth-first from the homepage, so the first few pages tend to
 * be structurally similar (nav items, top-level sections) — spreading the
 * sample out increases the odds of catching a page with different
 * templates, heavier content, or different third-party scripts.
 */
function selectPagesForBrowserAudit(pages, startUrl, sampleSize = 5) {
  const eligible = pages.filter(
    (p) => p.title !== undefined && p.statusCode && p.statusCode < 400,
  );
  if (eligible.length === 0) return [];

  const homepage = eligible.find((p) => p.url === startUrl) || eligible[0];
  const rest = eligible.filter((p) => p.url !== homepage.url);

  const selected = [homepage];
  const remainingSlots = sampleSize - 1;

  if (rest.length <= remainingSlots) {
    selected.push(...rest);
  } else {
    const step = rest.length / remainingSlots;
    for (let i = 0; i < remainingSlots; i += 1) {
      const idx = Math.min(rest.length - 1, Math.floor(i * step));
      selected.push(rest[idx]);
    }
  }

  // De-duplicate — evenly-spaced indices can collide on small lists.
  const seen = new Set();
  return selected.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });
}

module.exports = { selectPagesForBrowserAudit };
