const { planSearchQueries } = require('./queryPlanner');
const { searchMultiple } = require('./tavilySearch');
const { renderMultiple, closeBrowser } = require('./pageRenderer');
const { extractJobsFromPage } = require('./jobExtractor');
const { extractStructuredJobs } = require('../webExtract/structuredData');

/**
 * Full AI job-search pipeline:
 *
 * Candidate search prompt
 *        ↓
 * Gemini query planner
 *        ↓
 * Multiple broad search queries
 *        ↓
 * Tavily web search
 *        ↓
 * Candidate job pages
 *        ↓
 * Playwright rendering
 *        ↓
 * Structured-data extraction
 *        ↓
 * Gemini extraction fallback
 *        ↓
 * Deduped jobs
 *
 * The pipeline is deliberately role-first:
 * search queries should discover relevant jobs broadly.
 * Candidate skills should be used later for matching/ranking,
 * rather than being hard requirements during discovery.
 */
async function runAiSearchPipeline(
  prompt,
  { maxPages = 10 } = {}
) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY not set — AI search is not configured.'
    );
  }

  if (!process.env.TAVILY_API_KEY) {
    throw new Error(
      'TAVILY_API_KEY not set — AI search is not configured.'
    );
  }

  const cleanPrompt = (prompt || '').trim();

  if (!cleanPrompt) {
    console.warn(
      '[aiSearch:pipeline] Empty search prompt.'
    );
    return [];
  }

  console.log(
    '[aiSearch:pipeline] Starting AI search'
  );

  console.log(
    '[aiSearch:pipeline] Input prompt:',
    cleanPrompt
  );

  // ---------------------------------------------------------
  // STEP 1: Generate search queries
  // ---------------------------------------------------------

  let queries = [];

  try {
    queries = await planSearchQueries(
      cleanPrompt,
      { maxQueries: 5 }
    );
  } catch (err) {
    console.error(
      '[aiSearch:pipeline] Query planning failed:',
      err.message
    );

    // The planner itself normally falls back to the raw prompt,
    // but keep this second safety net here.
    queries = [cleanPrompt];
  }

  // Clean and deduplicate queries.

  queries = (Array.isArray(queries) ? queries : [])
    .filter(
      (query) =>
        typeof query === 'string' &&
        query.trim().length > 0
    )
    .map((query) => query.trim())
    .filter(
      (query, index, array) =>
        array.indexOf(query) === index
    )
    .slice(0, 5);

  console.log(
    '[aiSearch:pipeline] Planned queries:',
    queries
  );

  if (queries.length === 0) {
    console.warn(
      '[aiSearch:pipeline] No search queries generated.'
    );

    return [];
  }

  // ---------------------------------------------------------
  // STEP 2: Search Tavily
  // ---------------------------------------------------------

  let candidates = [];

  try {
    candidates = await searchMultiple(
      queries,
      {
        maxResultsPerQuery: 6
      }
    );
  } catch (err) {
    console.error(
      '[aiSearch:pipeline] Tavily search failed:',
      err.message
    );

    return [];
  }

  console.log(
    `[aiSearch:pipeline] Tavily returned ${candidates.length} unique candidate pages.`
  );

  if (candidates.length > 0) {
    console.log(
      '[aiSearch:pipeline] Candidate URLs:',
      candidates.map((candidate) => candidate.url)
    );
  }

  if (candidates.length === 0) {
    console.warn(
      '[aiSearch:pipeline] Tavily returned no candidate pages.'
    );

    return [];
  }

  // ---------------------------------------------------------
  // STEP 3: Limit pages to render
  // ---------------------------------------------------------

  const safeMaxPages = Math.max(
    1,
    Math.min(Number(maxPages) || 10, 15)
  );

  const toRender = candidates.slice(
    0,
    safeMaxPages
  );

  console.log(
    `[aiSearch:pipeline] Rendering ${toRender.length} of ${candidates.length} candidate pages.`
  );

  // ---------------------------------------------------------
  // STEP 4: Render pages
  // ---------------------------------------------------------

  let rendered = [];

  try {
    rendered = await renderMultiple(
      toRender.map((candidate) => candidate.url)
    );
  } catch (err) {
    console.error(
      '[aiSearch:pipeline] Page rendering failed:',
      err.message
    );

    return [];
  }

  console.log(
    `[aiSearch:pipeline] Successfully rendered ${rendered.length} pages.`
  );

  if (rendered.length === 0) {
    console.warn(
      '[aiSearch:pipeline] No pages could be rendered.'
    );

    return [];
  }

  // ---------------------------------------------------------
  // STEP 5: Extract jobs
  // ---------------------------------------------------------

  let structuredHits = 0;
  let aiFallbacks = 0;
  let extractionFailures = 0;

  const allJobs = [];

  /*
   * Process pages sequentially.
   *
   * This deliberately avoids firing many Gemini extraction
   * requests at the same time.
   *
   * Structured data is always attempted first because it
   * requires no Gemini request.
   */
  for (const page of rendered) {
    const { url, html } = page;

    if (!html) {
      console.warn(
        `[aiSearch:pipeline] Empty HTML for ${url}`
      );

      extractionFailures++;
      continue;
    }

    try {
      // -----------------------------------------------------
      // STEP 5A: Try structured job data first
      // -----------------------------------------------------

      const structured = extractStructuredJobs(
        html,
        url,
        'ai-search'
      );

      if (
        Array.isArray(structured) &&
        structured.length > 0
      ) {
        structuredHits++;

        console.log(
          `[aiSearch:pipeline] Structured extraction found ${structured.length} job(s) on ${url}`
        );

        allJobs.push(...structured);

        continue;
      }

      // -----------------------------------------------------
      // STEP 5B: Gemini fallback
      // -----------------------------------------------------

      aiFallbacks++;

      console.log(
        `[aiSearch:pipeline] No structured jobs found on ${url}; using Gemini extraction.`
      );

      const jobs = await extractJobsFromPage(
        html,
        url,
        'ai-search'
      );

      if (
        Array.isArray(jobs) &&
        jobs.length > 0
      ) {
        console.log(
          `[aiSearch:pipeline] Gemini extracted ${jobs.length} job(s) from ${url}`
        );

        allJobs.push(...jobs);
      } else {
        console.warn(
          `[aiSearch:pipeline] Gemini found no jobs on ${url}`
        );
      }

    } catch (err) {
      extractionFailures++;

      console.error(
        `[aiSearch:pipeline] Extraction failed for ${url}:`,
        err.message
      );
    }
  }

  // ---------------------------------------------------------
  // STEP 6: Extraction summary
  // ---------------------------------------------------------

  console.log(
    `[aiSearch:pipeline] Extraction summary:
    structured pages: ${structuredHits}
    Gemini fallback pages: ${aiFallbacks}
    failed pages: ${extractionFailures}
    jobs before deduplication: ${allJobs.length}`
  );

  if (allJobs.length === 0) {
    console.warn(
      '[aiSearch:pipeline] No jobs extracted from any page.'
    );

    return [];
  }

  // ---------------------------------------------------------
  // STEP 7: Normalize and deduplicate
  // ---------------------------------------------------------

  const byKey = new Map();

  for (const job of allJobs) {
    if (!job) continue;

    const title =
      typeof job.title === 'string'
        ? job.title.trim()
        : '';

    const url =
      typeof job.url === 'string'
        ? job.url.trim()
        : '';

    if (!title) continue;

    /*
     * URL + title is more reliable than URL alone.
     *
     * Some job listing pages contain many jobs but may not
     * provide individual application URLs.
     */
    const key =
      `${url || 'no-url'}::${title.toLowerCase()}`;

    if (!byKey.has(key)) {
      byKey.set(key, job);
    }
  }

  const finalJobs = [...byKey.values()];

  console.log(
    `[aiSearch:pipeline] Final jobs after deduplication: ${finalJobs.length}`
  );

  return finalJobs;
}

module.exports = {
  runAiSearchPipeline,
  closeBrowser
};
