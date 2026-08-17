const { callGemini } = require('./geminiClient');

/**
 * Convert a free-text prompt like "Software Engineering internships in UK"
 * into a small set of optimized search-engine queries. Splitting into a
 * few varied phrasings (rather than searching the raw prompt verbatim)
 * tends to surface more relevant, less redundant results from a general
 * web search than one literal query would.
 *
 * Falls back to using the raw prompt as a single query if Gemini isn't
 * configured or the call fails — this step should never be a hard
 * blocker for the rest of the pipeline.
 */
async function planSearchQueries(prompt, { maxQueries = 4 } = {}) {
  const clean = (prompt || '').trim();
  if (!clean) return [];

  try {
    const instruction = `You are helping search for real job/internship postings. Given this request:

"${clean}"

Generate up to ${maxQueries} distinct, effective web search queries that would surface actual job listing pages or company career pages matching this request. Vary the phrasing (e.g. different job title synonyms, "careers" vs "jobs" vs "vacancies", with/without location). Do not include linkedin.com or indeed.com in the queries — those are excluded from this pipeline.

Return ONLY a JSON array of strings, nothing else. Example: ["software engineering internship UK", "graduate software engineer jobs UK careers"]`;

    const response = await callGemini(instruction, { jsonMode: true });
    const queries = JSON.parse(response);
    if (Array.isArray(queries) && queries.length > 0) {
      return queries.slice(0, maxQueries).map(String);
    }
  } catch (err) {
    console.warn('[aiSearch:queryPlanner] Falling back to raw prompt:', err.message);
  }

  return [clean];
}

module.exports = { planSearchQueries };
