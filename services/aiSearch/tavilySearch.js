const axios = require('axios');

// Sites explicitly excluded because their Terms of Service prohibit
// automated access, and both actively enforce it. This is not a
// configurable option — do not add exceptions here. See README for why.
const EXCLUDED_DOMAINS = ['linkedin.com', 'indeed.com'];

/**
 * Run one search query against Tavily and return candidate result pages
 * (title, url, short content snippet). Requires TAVILY_API_KEY.
 */
async function tavilySearch(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[aiSearch:tavily] Skipped: TAVILY_API_KEY not set.');
    return [];
  }

  try {
    const { data } = await axios.post(
      'https://api.tavily.com/search',
      {
        query,
        max_results: maxResults,
        search_depth: 'basic',
        exclude_domains: EXCLUDED_DOMAINS,
      },
      {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  } catch (err) {
    console.error('[aiSearch:tavily] search failed:', err.response?.data || err.message);
    return [];
  }
}

/**
 * Run several queries and return a deduped list of candidate URLs.
 * Domain exclusion is enforced twice — once via Tavily's own
 * exclude_domains param, and again here as a hard safety net in case a
 * result slips through (e.g. a linkedin.com URL returned via a redirect
 * or aggregator listing).
 */
async function searchMultiple(queries, { maxResultsPerQuery = 5 } = {}) {
  const allResults = await Promise.all(queries.map((q) => tavilySearch(q, { maxResults: maxResultsPerQuery })));
  const flat = allResults.flat();

  const seen = new Set();
  const deduped = [];
  for (const result of flat) {
    if (!result.url || seen.has(result.url)) continue;
    if (EXCLUDED_DOMAINS.some((domain) => result.url.includes(domain))) continue;
    seen.add(result.url);
    deduped.push(result);
  }
  return deduped;
}

module.exports = { tavilySearch, searchMultiple, EXCLUDED_DOMAINS };
