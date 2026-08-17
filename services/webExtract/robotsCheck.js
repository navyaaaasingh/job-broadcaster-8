const axios = require('axios');

// Cache robots.txt per domain for the lifetime of the process — avoids
// re-fetching it on every single job search.
const robotsCache = new Map();

async function getRobotsRules(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);

  // Parses both Allow and Disallow directives under the wildcard (*)
  // user-agent block. Sites commonly combine a broad Disallow with a more
  // specific Allow carve-out (e.g. "Disallow: /" + "Allow: /jobs/") — a
  // parser that only reads Disallow would incorrectly block the whole
  // site in that case, even though the site explicitly permits /jobs/.
  const rules = [];
  try {
    const { data } = await axios.get(`${origin}/robots.txt`, { timeout: 5000 });
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
      if (!inWildcardBlock) continue;

      const disallowMatch = line.match(/^disallow:\s*(.*)$/i);
      if (disallowMatch) {
        const path = disallowMatch[1].trim();
        // An empty "Disallow:" means "nothing is disallowed" per spec —
        // not "disallow the empty-string prefix" (which would match
        // every path). Skip it rather than adding a rule for it.
        if (path) rules.push({ type: 'disallow', path });
        continue;
      }
      const allowMatch = line.match(/^allow:\s*(.*)$/i);
      if (allowMatch) {
        const path = allowMatch[1].trim();
        if (path) rules.push({ type: 'allow', path });
      }
    }
  } catch (err) {
    // No robots.txt, or it failed to load — treat as "nothing disallowed"
    // rather than blocking the fetch on a network hiccup.
  }

  robotsCache.set(origin, rules);
  return rules;
}

/**
 * Standard robots.txt resolution: the MOST SPECIFIC matching rule wins
 * (longest matching path), regardless of whether it's Allow or Disallow.
 * On an exact tie in length, Allow wins — this matches the de facto
 * standard most crawlers (including Google's) follow, even though the
 * original spec doesn't fully define tie-breaking.
 */
function isPathAllowed(pathname, rules) {
  let best = null;
  for (const rule of rules) {
    if (!pathname.startsWith(rule.path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.type === 'allow')) {
      best = { type: rule.type, length };
    }
  }
  if (!best) return true; // no matching rule at all => allowed
  return best.type === 'allow';
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
  const rules = await getRobotsRules(origin);
  return isPathAllowed(parsed.pathname, rules);
}

module.exports = { isFetchAllowed };
