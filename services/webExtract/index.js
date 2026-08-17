const axios = require('axios');
const sources = require('./sources');
const { isFetchAllowed } = require('./robotsCheck');
const { extractStructuredJobs } = require('./structuredData');
const { extractJobsWithAI } = require('./aiExtract');

/**
 * Fetch and extract jobs from every configured source in services/webExtract/sources.js.
 * For each source: check robots.txt allows it, fetch the page, try
 * structured data (schema.org JobPosting — free, reliable) first, and only
 * fall back to AI extraction if nothing structured was found.
 *
 * A failure on any single source (network error, blocked by robots.txt,
 * AI extraction failure) is logged and skipped — it never breaks the rest
 * of the search.
 */
async function fetchWebExtractedJobs() {
  if (sources.length === 0) return [];

  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const allowed = await isFetchAllowed(source.url);
        if (!allowed) {
          console.warn(`[webExtract:${source.id}] Skipped — disallowed by robots.txt.`);
          return [];
        }

        const { data: html } = await axios.get(source.url, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobBroadcaster/1.0)' },
        });

        const structured = extractStructuredJobs(html, source.url, source.id);
        if (structured.length > 0) {
          console.log(`[webExtract:${source.id}] Found ${structured.length} job(s) via structured data.`);
          return structured;
        }

        console.log(`[webExtract:${source.id}] No structured data found, trying AI extraction...`);
        const aiJobs = await extractJobsWithAI(html, source.url, source.id);
        console.log(`[webExtract:${source.id}] AI extraction found ${aiJobs.length} job(s).`);
        return aiJobs;
      } catch (err) {
        console.error(`[webExtract:${source.id}] fetch failed:`, err.message);
        return [];
      }
    })
  );

  return results.flat();
}

module.exports = { fetchWebExtractedJobs };
