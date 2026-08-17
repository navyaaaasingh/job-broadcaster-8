const { planSearchQueries } = require('./queryPlanner');
const { searchMultiple } = require('./tavilySearch');
const { renderMultiple, closeBrowser } = require('./pageRenderer');
const { extractJobsFromPage } = require('./jobExtractor');

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
async function runAiSearchPipeline(prompt, { maxPages = 6 } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set — AI search is not configured.');
  }
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not set — AI search is not configured.');
  }

  const queries = await planSearchQueries(prompt);
  if (queries.length === 0) return [];

  const candidates = await searchMultiple(queries, { maxResultsPerQuery: 5 });
  const toRender = candidates.slice(0, maxPages);
  if (toRender.length === 0) return [];

  const rendered = await renderMultiple(toRender.map((c) => c.url));

  const extractedPerPage = await Promise.all(
    rendered.map(({ url, html }) => extractJobsFromPage(html, url, 'ai-search'))
  );
  const allJobs = extractedPerPage.flat();

  // Dedupe by URL — the same posting can legitimately show up from
  // multiple search queries.
  const byUrl = new Map();
  for (const job of allJobs) {
    if (job.url && job.title) byUrl.set(job.url, job);
  }
  return [...byUrl.values()];
}

module.exports = { runAiSearchPipeline, closeBrowser };
