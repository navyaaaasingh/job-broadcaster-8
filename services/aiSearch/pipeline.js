const { planSearchQueries } = require('./queryPlanner');
const { searchMultiple } = require('./tavilySearch');
const { renderMultiple, closeBrowser } = require('./pageRenderer');
const { extractJobsFromPage } = require('./jobExtractor');
const { extractStructuredJobs } = require('../webExtract/structuredData');

function looksLikeDirectJobSearch(prompt) {
  const clean = (prompt || '').trim().toLowerCase();

  // Resume-generated searchQuery values are already curated by Gemini.
  // Running them through a second Gemini query-planning call is redundant.
  return (
    clean.length <= 500 &&
    /\bjobs?\b/.test(clean) &&
    (clean.includes(',') ||
      /\b(entry[- ]level|junior|associate|graduate|internship|intern)\b/.test(clean))
  );
}

function buildDirectQueries(prompt, maxQueries) {
  const clean = prompt.trim();
  const queries = [clean];

  if (queries.length < maxQueries && !/\bcareers?\b/i.test(clean)) {
    queries.push(`${clean} careers`);
  }

  if (
    queries.length < maxQueries &&
    /\b(intern|internship|graduate)\b/i.test(clean) &&
    !/\bentry[- ]level\b/i.test(clean)
  ) {
    queries.push(`${clean} entry-level`);
  }

  return queries.slice(0, maxQueries);
}

/**
 * Full AI job-search pipeline.
 *
 * Gemini is kept out of discovery when the input is already a curated,
 * resume-style job query. This removes an unnecessary Gemini request per
 * resume while preserving the Gemini planner for free-form AI searches.
 */
async function runAiSearchPipeline(
  prompt,
  {
    maxPages = 6,
    maxQueries = 3,
    maxResultsPerQuery = 4,
    maxGeminiFallbacks = 2,
    queryOverride = null,
  } = {}
) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set — AI search is not configured.');
  }

  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not set — AI search is not configured.');
  }

  const cleanPrompt = (prompt || '').trim();

  if (!cleanPrompt) {
    console.warn('[aiSearch:pipeline] Empty search prompt.');
    return [];
  }

  console.log('[aiSearch:pipeline] Starting AI search');
  console.log('[aiSearch:pipeline] Input prompt:', cleanPrompt);

  // ---------------------------------------------------------
  // STEP 1: Generate or reuse search queries
  // ---------------------------------------------------------

  let queries = Array.isArray(queryOverride) && queryOverride.length > 0
    ? queryOverride
    : [];

  if (queries.length === 0 && looksLikeDirectJobSearch(cleanPrompt)) {
    queries = buildDirectQueries(cleanPrompt, maxQueries);
    console.log(
      '[aiSearch:pipeline] Curated job query detected; skipping Gemini query planning.'
    );
  }

  if (queries.length === 0) {
    try {
      queries = await planSearchQueries(cleanPrompt, { maxQueries });
    } catch (err) {
      console.error(
        '[aiSearch:pipeline] Query planning failed:',
        err.message
      );
      queries = [cleanPrompt];
    }
  }

  queries = (Array.isArray(queries) ? queries : [])
    .filter((query) => typeof query === 'string' && query.trim().length > 0)
    .map((query) => query.trim())
    .filter((query, index, array) => array.indexOf(query) === index)
    .slice(0, Math.max(1, Number(maxQueries) || 3));

  console.log('[aiSearch:pipeline] Planned queries:', queries);

  if (queries.length === 0) {
    console.warn('[aiSearch:pipeline] No search queries generated.');
    return [];
  }

  // ---------------------------------------------------------
  // STEP 2: Search Tavily
  // ---------------------------------------------------------

  let candidates = [];

  try {
    candidates = await searchMultiple(queries, { maxResultsPerQuery });
  } catch (err) {
    console.error('[aiSearch:pipeline] Tavily search failed:', err.message);
    return [];
  }

  console.log(
    `[aiSearch:pipeline] Tavily returned ${candidates.length} unique candidate pages.`
  );

  if (candidates.length === 0) {
    console.warn('[aiSearch:pipeline] Tavily returned no candidate pages.');
    return [];
  }

  // ---------------------------------------------------------
  // STEP 3: Limit pages to render
  // ---------------------------------------------------------

  const safeMaxPages = Math.max(1, Math.min(Number(maxPages) || 6, 10));
  const toRender = candidates.slice(0, safeMaxPages);

  console.log(
    `[aiSearch:pipeline] Rendering ${toRender.length} of ${candidates.length} candidate pages.`
  );

  // ---------------------------------------------------------
  // STEP 4: Render pages
  // ---------------------------------------------------------

  let rendered = [];

  try {
    rendered = await renderMultiple(toRender.map((candidate) => candidate.url));
  } catch (err) {
    console.error('[aiSearch:pipeline] Page rendering failed:', err.message);
    return [];
  }

  console.log(
    `[aiSearch:pipeline] Successfully rendered ${rendered.length} pages.`
  );

  if (rendered.length === 0) {
    console.warn('[aiSearch:pipeline] No pages could be rendered.');
    return [];
  }

  // ---------------------------------------------------------
  // STEP 5: Extract jobs
  // ---------------------------------------------------------

  let structuredHits = 0;
  let aiFallbacks = 0;
  let extractionFailures = 0;
  const allJobs = [];

  // Structured data requires no Gemini request. Keep Gemini fallbacks small
  // so one search cannot consume the entire Free-tier daily allowance.
  const fallbackLimit = Math.max(
    0,
    Math.min(Number(maxGeminiFallbacks) || 2, rendered.length)
  );

  for (const page of rendered) {
    const { url, html } = page;

    if (!html) {
      console.warn(`[aiSearch:pipeline] Empty HTML for ${url}`);
      extractionFailures++;
      continue;
    }

    try {
      const structured = extractStructuredJobs(html, url, 'ai-search');

      if (Array.isArray(structured) && structured.length > 0) {
        structuredHits++;
        console.log(
          `[aiSearch:pipeline] Structured extraction found ${structured.length} job(s) on ${url}`
        );
        allJobs.push(...structured);
        continue;
      }

      if (aiFallbacks >= fallbackLimit) {
        console.log(
          `[aiSearch:pipeline] Skipping Gemini fallback for ${url}; fallback budget exhausted.`
        );
        continue;
      }

      aiFallbacks++;
      console.log(
        `[aiSearch:pipeline] No structured jobs found on ${url}; using Gemini extraction (${aiFallbacks}/${fallbackLimit}).`
      );

      const jobs = await extractJobsFromPage(html, url, 'ai-search');

      if (Array.isArray(jobs) && jobs.length > 0) {
        console.log(
          `[aiSearch:pipeline] Gemini extracted ${jobs.length} job(s) from ${url}`
        );
        allJobs.push(...jobs);
      } else {
        console.warn(`[aiSearch:pipeline] Gemini found no jobs on ${url}`);
      }
    } catch (err) {
      extractionFailures++;
      console.error(
        `[aiSearch:pipeline] Extraction failed for ${url}:`,
        err.message
      );
    }
  }

  console.log(
    `[aiSearch:pipeline] Extraction summary:\n    structured pages: ${structuredHits}\n    Gemini fallback pages: ${aiFallbacks}\n    failed pages: ${extractionFailures}\n    jobs before deduplication: ${allJobs.length}`
  );

  if (allJobs.length === 0) {
    console.warn('[aiSearch:pipeline] No jobs extracted from any page.');
    return [];
  }

  // ---------------------------------------------------------
  // STEP 6: Normalize and deduplicate
  // ---------------------------------------------------------

  const byKey = new Map();

  for (const job of allJobs) {
    if (!job) continue;

    const title = typeof job.title === 'string' ? job.title.trim() : '';
    const url = typeof job.url === 'string' ? job.url.trim() : '';

    if (!title) continue;

    const key = `${url || 'no-url'}::${title.toLowerCase()}`;

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
