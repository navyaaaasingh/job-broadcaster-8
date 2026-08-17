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

  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      params: {
        app_id: appId,
        app_key: appKey,
        // what_and requires every search term to appear, rather than
        // matching if ANY one term does (which is what the plain `what`
        // param does) — this cuts down on loosely-related results like a
        // driving job showing up for an "IT support" search just because
        // it happens to mention "support" somewhere.
        what_and: keywords || undefined,
        where: location || undefined,
        results_per_page: 25,
      },
    });
    return (data.results || []).map(normalize);
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
