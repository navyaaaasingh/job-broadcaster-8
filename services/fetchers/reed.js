const axios = require('axios');

async function fetchReedJobs({ keywords, location }) {
  const apiKey = process.env.REED_API_KEY;

  if (!apiKey) {
    console.warn('[reed] Skipped: REED_API_KEY not set.');
    return [];
  }

  const url = 'https://www.reed.co.uk/api/1.0/search';

  async function request(params) {
    const { data } = await axios.get(url, {
      timeout: 10000,
      auth: { username: apiKey, password: '' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JobBroadcaster/1.0)',
      },
      params: {
        ...params,
        resultsToTake: 25,
      },
    });
    return data.results || [];
  }

  try {
    // First use Reed's native location search.
    let results = await request({
      keywords: keywords || undefined,
      locationName: location || undefined,
    });

    // Reed's location index may not recognise every free-form county,
    // district, or smaller place. Retry using the location as part of the
    // keyword query so free-form locations do not behave like invalid input.
    if (results.length === 0 && location) {
      console.warn(`[reed] No results for location "${location}". Retrying with location as search text.`);
      results = await request({
        keywords: [keywords, location].filter(Boolean).join(' '),
      });
    }

    return results.map(normalize);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    if (status === 403) {
      console.error(
        '[reed] fetch failed: 403 Forbidden — either REED_API_KEY is invalid, or Reed\'s ' +
          'Cloudflare bot protection is challenging requests from this server\'s IP ' +
          '(common on cloud-hosting platforms). See response body for details.',
        typeof body === 'string' ? body.slice(0, 300) : body
      );
    } else {
      console.error('[reed] fetch failed:', status, err.message);
    }
    return [];
  }
}

function normalize(job) {
  return {
    id: `reed:${job.jobId}`,
    source: 'reed',
    title: job.jobTitle?.trim(),
    company: job.employerName || 'Unknown',
    location: job.locationName || '',
    salaryMin: job.minimumSalary || null,
    salaryMax: job.maximumSalary || null,
    description: (job.jobDescription || '').trim(),
    url: job.jobUrl,
    postedAt: job.date,
  };
}

module.exports = { fetchReedJobs };
