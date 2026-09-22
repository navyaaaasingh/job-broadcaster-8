const axios = require('axios');

async function fetchJoobleJobs({ keywords, location }) {
  const apiKey = process.env.JOOBLE_API_KEY;

  if (!apiKey) {
    console.warn('[jooble] Skipped: JOOBLE_API_KEY not set.');
    return [];
  }

  const url = `https://jooble.org/api/${apiKey}`;

  async function request(body) {
    const { data } = await axios.post(url, body, { timeout: 10000 });
    return data.jobs || [];
  }

  try {
    // First use Jooble's native location field.
    let results = await request({
      keywords: keywords || '',
      location: location || '',
    });

    // If Jooble does not recognise a free-form location, retry with the
    // location included in the search text rather than treating it as an
    // invalid search.
    if (results.length === 0 && location) {
      console.warn(`[jooble] No results for location "${location}". Retrying with location as search text.`);
      results = await request({
        keywords: [keywords, location].filter(Boolean).join(' '),
        location: '',
      });
    }

    return results.map(normalize);
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
