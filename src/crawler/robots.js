const robotsParser = require('robots-parser');

/**
 * Fetch and parse robots.txt for a domain. Returns null (meaning "allow
 * everything") if it's unreachable, rather than blocking the crawl on it.
 */
async function fetchRobots(scheme, domain, userAgentHeader, timeoutMs) {
  const robotsUrl = `${scheme}://${domain}/robots.txt`;
  try {
    const resp = await fetch(robotsUrl, {
      headers: { 'User-Agent': userAgentHeader },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = resp.status < 400 ? await resp.text() : '';
    return robotsParser(robotsUrl, text);
  } catch (err) {
    return null;
  }
}

function isAllowed(robots, url, userAgentToken) {
  if (!robots) return true;
  try {
    const result = robots.isAllowed(url, userAgentToken);
    // robots-parser returns undefined for some edge cases (e.g. malformed
    // robots.txt) — treat "unknown" the same as "allowed", not "blocked".
    return result === undefined ? true : result;
  } catch (err) {
    return true;
  }
}

module.exports = { fetchRobots, isAllowed };
