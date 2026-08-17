const axios = require('axios');

// Cache robots.txt per domain for the lifetime of the process — avoids
// re-fetching it on every single job search.
const robotsCache = new Map();

async function getRobotsRules(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);

  let disallowed = [];
  try {
    const { data } = await axios.get(`${origin}/robots.txt`, { timeout: 5000 });
    // Minimal parser: only look at the generic "*" user-agent block, and
    // only care about Disallow rules — good enough for a permission check,
    // not a full robots.txt spec implementation.
    let inWildcardBlock = false;
    for (const rawLine of data.split('\n')) {
      const line = rawLine.trim();
      if (/^user-agent:\s*\*/i.test(line)) {
        inWildcardBlock = true;
        continue;
      }
      if (/^user-agent:/i.test(line)) {
        inWildcardBlock = false;
        continue;
      }
      if (inWildcardBlock && /^disallow:/i.test(line)) {
        const path = line.split(':').slice(1).join(':').trim();
        if (path) disallowed.push(path);
      }
    }
  } catch (err) {
    // No robots.txt, or it failed to load — treat as "nothing disallowed"
    // rather than blocking the fetch on a network hiccup.
    disallowed = [];
  }

  robotsCache.set(origin, disallowed);
  return disallowed;
}

/** Returns true if fetching this URL is allowed by the site's robots.txt. */
async function isFetchAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const disallowed = await getRobotsRules(origin);
  return !disallowed.some((rule) => parsed.pathname.startsWith(rule));
}

module.exports = { isFetchAllowed };
