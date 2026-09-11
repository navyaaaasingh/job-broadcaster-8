const { planSearchQueries } = require('./queryPlanner');
const { searchMultiple } = require('./tavilySearch');
const { renderMultiple, closeBrowser } = require('./pageRenderer');
const { extractJobsFromPage } = require('./jobExtractor');
const { extractStructuredJobs } = require('../webExtract/structuredData');
const { reportProgress } = require('../searchProgress');

function looksLikeDirectJobSearch(prompt) {
  const clean = (prompt || '').trim().toLowerCase();

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

  reportProgress(8, 'Understanding your search', 'Interpreting your request and preparing the search.');
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
    console.log('[aiSearch:pipeline] Curated job query detected; skipping Gemini query planning.');
  }

  if (queries.length === 0) {
    try {
      queries = await planSearchQueries(cleanPrompt, { maxQueries });
    } catch (err) {
      console.error('[aiSearch:pipeline] Query planning failed:', err.message);
      queries = [cleanPrompt];
    }
  }

  queries = (Array.isArray(queries) ? queries : [])
    .filter((query) => typeof query === 'string' && query.trim().length > 0)
    .map((query) => query.trim())
    .filter((query, index, array) => array.indexOf(query) === index)
    .slice(0, Math.max(1, Number(maxQueries) || 3));

  console.log('[aiSearch:pipeline] Planned queries:', queries);
  reportProgress(18, 'Finding relevant jobs', `Searching across ${queries.length} search quer${queries.length === 1 ? 'y' : 'ies'}.`);

  if (queries.length === 0) return [];

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

  console.log(`[aiSearch:pipeline] Tavily returned ${candidates.length} unique candidate pages.`);
  reportProgress(34, 'Finding relevant jobs', `Found ${candidates.length} candidate job pages.`);

  if (candidates.length === 0) return [];

  // ---------------------------------------------------------
  // STEP 3: Limit and render pages
  // ---------------------------------------------------------
  const safeMaxPages = Math.max(1, Math.min(Number(maxPages) || 6, 10));
  const toRender = candidates.slice(0, safeMaxPages);

  console.log(`[aiSearch:pipeline] Rendering ${toRender.length} of ${candidates.length} candidate pages.`);
  reportProgress(42, 'Analysing job requirements', `Opening ${toRender.length} relevant job pages.`);

  let rendered = [];
  try {
    rendered = await renderMultiple(toRender.map((candidate) => candidate.url));
  } catch (err) {
    console.error('[aiSearch:pipeline] Page rendering failed:', err.message);
    return [];
  }

  console.log(`[aiSearch:pipeline] Successfully rendered ${rendered.length} pages.`);
  reportProgress(54, 'Analysing job requirements', `Analysed ${rendered.length} job pages.`);

  if (rendered.length === 0) return [];

  // ---------------------------------------------------------
  // STEP 4: Extract jobs
  // ---------------------------------------------------------
  let structuredHits = 0;
  let aiFallbacks = 0;
  let extractionFailures = 0;
  const allJobs = [];
  const fallbackLimit = Math.max(0, Math.min(Number(maxGeminiFallbacks) || 2, rendered.length));

  for (let index = 0; index < rendered.length; index += 1) {
    const page = rendered[index];
    const { url, html } = page;

    if (!html) {
      extractionFailures++;
      continue;
    }

    try {
      const structured = extractStructuredJobs(html, url, 'ai-search');

      if (Array.isArray(structured) && structured.length > 0) {
        structuredHits++;
        allJobs.push(...structured);
      } else if (aiFallbacks < fallbackLimit) {
        aiFallbacks++;
        const jobs = await extractJobsFromPage(html, url, 'ai-search');
        if (Array.isArray(jobs) && jobs.length > 0) allJobs.push(...jobs);
      }
    } catch (err) {
      extractionFailures++;
      console.error(`[aiSearch:pipeline] Extraction failed for ${url}:`, err.message);
    }

    const extractionPercent = 54 + (((index + 1) / rendered.length) * 26);
    reportProgress(
      extractionPercent,
      'Matching jobs to your criteria',
      `Analysed ${index + 1} of ${rendered.length} job pages.`
    );
  }

  console.log(
    `[aiSearch:pipeline] Extraction summary:\n    structured pages: ${structuredHits}\n    Gemini fallback pages: ${aiFallbacks}\n    failed pages: ${extractionFailures}\n    jobs before deduplication: ${allJobs.length}`
  );

  if (allJobs.length === 0) return [];

  // ---------------------------------------------------------
  // STEP 5: Normalize and deduplicate
  // ---------------------------------------------------------
  reportProgress(84, 'Ranking the best matches', 'Removing duplicates and prioritising the strongest matches.');

  const byKey = new Map();
  for (const job of allJobs) {
    if (!job) continue;

    const title = typeof job.title === 'string' ? job.title.trim() : '';
    const url = typeof job.url === 'string' ? job.url.trim() : '';
    if (!title) continue;

    const key = `${url || 'no-url'}::${title.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, job);
  }

  const finalJobs = [...byKey.values()];
  reportProgress(94, 'Preparing your results', `Preparing ${finalJobs.length} relevant job result${finalJobs.length === 1 ? '' : 's'}.`);

  console.log(`[aiSearch:pipeline] Final jobs after deduplication: ${finalJobs.length}`);
  return finalJobs;
}

module.exports = {
  runAiSearchPipeline,
  closeBrowser
};
