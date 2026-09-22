const axios = require('axios');

async function fetchAdzunaJobs({ keywords, location, page = 1 }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const country = process.env.ADZUNA_COUNTRY || 'gb';

  if (!appId || !appKey) {
    console.warn('[adzuna] Skipped: ADZUNA_APP_ID / ADZUNA_APP_KEY not set.');
    return [];
  }

  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`;

  async function request(params) {
    const { data } = await axios.get(url, {
      timeout: 10000,
      params: {
        app_id: appId,
        app_key: appKey,
        ...params,
        results_per_page: 25,
      },
    });
    return data.results || [];
  }

  try {
    // First use the provider's native location search.
    let results = await request({
      what_and: keywords || undefined,
      where: location || undefined,
    });

    // Adzuna's location index does not contain every county, district,
    // neighbourhood, or user-entered place name. If the exact location
    // produces no results, retry with the location included as search text
    // instead of silently returning nothing.
    if (results.length === 0 && location) {
      console.warn(`[adzuna] No results for location "${location}". Retrying with location as search text.`);
      results = await request({
        what_and: [keywords, location].filter(Boolean).join(' '),
      });
    }

    return results.map(normalize);
  } catch (err) {
    console.error('[adzuna] fetch failed:', err.response?.status, err.response?.data?.exception || err.message);
    return [];
  }
}

function normalize(job) {
  return {
    id: `adzuna:${job.id}`,
    source: 'adzuna',
    title: job.title?.trim(),
    company: job.company?.display_name || 'Unknown',
    location: job.location?.display_name || '',
    salaryMin: job.salary_min || null,
    salaryMax: job.salary_max || null,
    description: (job.description || '').trim(),
    url: job.redirect_url,
    postedAt: job.created,
  };
}

module.exports = { fetchAdzunaJobs };
