const { callGemini } = require('./geminiClient');

/**
 * Convert a candidate's search request into several broad,
 * complementary web-search queries.
 *
 * IMPORTANT:
 * Queries are designed primarily around job titles/roles.
 * Candidate skills are used as supporting context, but should
 * NOT become mandatory requirements for every search.
 *
 * This prevents qualified jobs from being excluded simply
 * because a job description does not mention every candidate skill.
 */
async function planSearchQueries(prompt, { maxQueries = 5 } = {}) {
  const clean = (prompt || '').trim();

  if (!clean) return [];

  try {
    const instruction = `You are an expert job-search query planner.

Candidate job-search request:

"${clean}"

Generate up to ${maxQueries} complementary web search queries that are likely to find REAL job or internship postings.

Search strategy:

1. Prioritize the candidate's most realistic target JOB TITLES.
2. Use role synonyms and closely related titles.
3. Keep searches broad enough to discover relevant openings.
4. Do NOT require every candidate skill to appear in the search query.
5. Skills should be used selectively as supporting context when useful.
6. Account for the candidate's experience level.
7. Preserve the candidate's location when one is provided.
8. Include a mixture of:
   - exact role searches
   - role synonym searches
   - entry-level/graduate variants when appropriate
   - closely related roles when appropriate
9. Search for actual job postings, company career pages, vacancies, openings, internships, or graduate roles.
10. Do not search LinkedIn or Indeed.
11. Do not include linkedin.com or indeed.com in queries.
12. Do not create duplicate or nearly identical queries.

IMPORTANT:
Do NOT create highly restrictive queries containing every skill.
For example, avoid queries like:
"Product Manager Python SQL RAG Pandas MongoDB"

Prefer:
"Associate Product Manager jobs"
"AI Product Manager jobs"
"Junior Product Manager jobs"

Return ONLY a valid JSON array of strings.

Example:
[
  "associate product manager jobs",
  "junior product manager jobs",
  "AI product manager jobs",
  "product management graduate jobs",
  "product analyst jobs"
]`;

    const response = await callGemini(instruction, {
      jsonMode: true
    });

    const queries = JSON.parse(response);

    if (Array.isArray(queries) && queries.length > 0) {
      return queries
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
        .slice(0, maxQueries);
    }
  } catch (err) {
    console.warn(
      '[aiSearch:queryPlanner] Falling back to raw prompt:',
      err.message
    );
  }

  // If Gemini fails, the raw candidate query is still usable.
  return [clean];
}

module.exports = {
  planSearchQueries
};
