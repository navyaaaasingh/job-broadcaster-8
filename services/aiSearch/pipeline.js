const { planSearchQueries } = require('./queryPlanner');
const { searchMultiple } = require('./tavilySearch');
const { renderMultiple, closeBrowser } = require('./pageRenderer');
const { extractJobsFromPage } = require('./jobExtractor');
const { extractStructuredJobs } = require('../webExtract/structuredData');

/**
 * Full pipeline: natural-language prompt -> optimized search queries
 * (Gemini) -> candidate pages (Tavily, LinkedIn/Indeed excluded) ->
 * rendered HTML (Playwright, for JS-heavy pages) -> structured jobs
 * (Gemini) -> deduped result list, in the app's standard job shape so it
 * merges cleanly with Adzuna/Reed/Jooble/webExtract results.
 *
 * Every step degrades gracefully rather than throwing: a failed render or
 * extraction for one page just means fewer results, not a broken search.
 */
async function runAiSearchPipeline(prompt, { maxPages = 8 } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set — AI search is not configured.');
  }
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not set — AI search is not configured.');
  }

  const queries = await planSearchQueries(prompt);
  if (queries.length === 0) return [];

  const candidates = await searchMultiple(queries, { maxResultsPerQuery: 6 });
  const toRender = candidates.slice(0, maxPages);
  if (toRender.length === 0) return [];

  const rendered = await renderMultiple(toRender.map((c) => c.url));

  // Extract sequentially, not with Promise.all — firing every page's
  // extraction call simultaneously is exactly what was tripping Gemini's
  // free-tier rate limit (a handful of pages here, times multiple
  // concurrent searches elsewhere, easily bursts past requests/minute).
  // Slower, but reliable — callGemini already retries transient 429s with
  // backoff, but avoiding the burst in the first place is better than
  // relying on retries to absorb it.
  //
  // For each page, try structured data (schema.org/JobPosting) FIRST —
  // many job sites publish this specifically so it can be read without
  // any AI involved. Only fall back to a Gemini call when nothing
  // structured is present. This is the single biggest lever for staying
  // under a free-tier rate limit: it skips the expensive step entirely
  // on any page that already has clean data sitting in its HTML, rather
  // than just making the Gemini call cheaper or more resilient.
  let structuredHits = 0;
  let aiFallbacks = 0;
  const allJobs = [];
  for (const { url, html } of rendered) {
    const structured = extractStructuredJobs(html, url, 'ai-search');
    if (structured.length > 0) {
      structuredHits++;
      allJobs.push(...structured);
      continue;
    }
    aiFallbacks++;
    const jobs = await extractJobsFromPage(html, url, 'ai-search');
    allJobs.push(...jobs);
  }
  console.log(
    `[aiSearch:pipeline] ${structuredHits} page(s) used structured data (no AI call), ${aiFallbacks} page(s) needed Gemini extraction.`
  );

  // Dedupe by URL + title together — not URL alone. If extraction falls
  // back to a listing page's own URL for several distinct jobs on it
  // (couldn't find each one's specific apply link), keying on URL alone
  // would silently collapse all of them into a single result.
  const byKey = new Map();
  for (const job of allJobs) {
    if (job.url && job.title) byKey.set(`${job.url}::${job.title.toLowerCase()}`, job);
  }
  return [...byKey.values()];
}

module.exports = { runAiSearchPipeline, closeBrowser };
