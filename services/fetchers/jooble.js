const axios = require('axios');

async function fetchJoobleJobs({ keywords, location }) {
  const apiKey = process.env.JOOBLE_API_KEY;

  if (!apiKey) {
    console.warn('[jooble] Skipped: JOOBLE_API_KEY not set.');
    return [];
  }

  const url = `https://jooble.org/api/${apiKey}`;

  try {
    const { data } = await axios.post(
      url,
      { keywords: keywords || '', location: location || '' },
      { timeout: 10000 }
    );
    return (data.jobs || []).map(normalize);
  } catch (err) {
    console.error('[jooble] fetch failed:', err.response?.status, err.message);
    return [];
  }
}

function normalize(job) {
  const idSource = job.id || job.link;
  return {
    id: `jooble:${idSource}`,
    source: 'jooble',
    title: (job.title || '').trim(),
    company: job.company || 'Unknown',
    location: job.location || '',
    salaryMin: null,
    salaryMax: null,
    salaryText: job.salary || null,
    description: (job.snippet || '').trim(),
    url: job.link,
    postedAt: job.updated,
  };
}

module.exports = { fetchJoobleJobs };
