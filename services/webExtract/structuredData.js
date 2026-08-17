const cheerio = require('cheerio');

function stripHtml(html) {
  if (!html) return '';
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

/**
 * Look for schema.org JobPosting structured data embedded in the page
 * (a <script type="application/ld+json"> block many job sites publish
 * specifically so search engines — and code like this — can read listings
 * without needing to parse arbitrary page layout). When present, this is
 * far more reliable than AI extraction and costs nothing to run.
 *
 * Returns an array of normalized job objects (possibly empty if no
 * structured data is found — caller should fall back to AI extraction).
 */
function extractStructuredJobs(html, pageUrl, sourceId) {
  const $ = cheerio.load(html);
  const jobs = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch {
      return; // malformed JSON-LD — skip this block
    }

    // JSON-LD can be a single object, an array, or wrapped in @graph.
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed['@graph'])
      ? parsed['@graph']
      : [parsed];

    for (const item of candidates) {
      const type = item?.['@type'];
      const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJobPosting) continue;

      const location =
        item.jobLocation?.address?.addressLocality ||
        item.jobLocation?.address?.addressRegion ||
        item.jobLocation?.name ||
        '';

      let salaryMin = null;
      let salaryMax = null;
      const salary = item.baseSalary?.value;
      if (salary) {
        salaryMin = salary.minValue ?? salary.value ?? null;
        salaryMax = salary.maxValue ?? salary.value ?? null;
      }

      jobs.push({
        id: `${sourceId}:${item.identifier?.value || item.url || pageUrl}`,
        source: sourceId,
        title: (item.title || '').trim(),
        company: item.hiringOrganization?.name || 'Unknown',
        location,
        salaryMin,
        salaryMax,
        description: stripHtml(item.description).slice(0, 2000),
        url: item.url || pageUrl,
        postedAt: item.datePosted || null,
      });
    }
  });

  return jobs.filter((j) => j.title); // discard anything that came back empty
}

module.exports = { extractStructuredJobs, stripHtml };
