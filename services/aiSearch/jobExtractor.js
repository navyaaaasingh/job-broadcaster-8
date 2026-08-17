const cheerio = require('cheerio');
const { callGemini } = require('./geminiClient');

/**
 * Strip a rendered page down to a link-preserving text blob for the AI to
 * read. Keeps <a href> as [text](url) since job listings are mostly
 * identified by their apply links — losing those makes extraction useless.
 */
function preparePageTextForAI(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, svg, noscript').remove();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (text && href) $(el).replaceWith(`[${text}](${href})`);
  });

  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, 12000);
}

/**
 * Ask Gemini to extract job postings from a rendered page's text into the
 * app's standard job shape. Returns an empty array on any failure — this
 * is a best-effort step, one bad page should never break the whole search.
 */
async function extractJobsFromPage(html, pageUrl, sourceLabel) {
  const pageText = preparePageTextForAI(html);
  if (!pageText) return [];

  const prompt = `Below is text extracted from a job listings webpage, with links preserved as [link text](url).

Extract every genuine job or internship posting you can find. Return ONLY a JSON array where each item has exactly these fields:
{"title": string, "company": string or null, "location": string or null, "description": string or null, "url": string or null, "salaryMin": number or null, "salaryMax": number or null, "postedAt": string or null}

Use the href from the closest relevant [text](url) link as the "url" field — it may be a relative path, that's fine, leave it as-is. If there are no real job postings on this page, return an empty array [].

Page text:
${pageText}`;

  try {
    const response = await callGemini(prompt, { jsonMode: true });
    const rawJobs = JSON.parse(response);
    if (!Array.isArray(rawJobs)) return [];

    return rawJobs
      .filter((j) => j && j.title)
      .map((j, i) => {
        let resolvedUrl = pageUrl;
        if (j.url) {
          try {
            resolvedUrl = new URL(j.url, pageUrl).href;
          } catch {
            resolvedUrl = pageUrl;
          }
        }
        return {
          id: `ai:${sourceLabel}:${resolvedUrl}:${i}`,
          source: sourceLabel,
          title: String(j.title).trim(),
          company: j.company || 'Unknown',
          location: j.location || '',
          salaryMin: j.salaryMin ?? null,
          salaryMax: j.salaryMax ?? null,
          description: j.description || '',
          url: resolvedUrl,
          postedAt: j.postedAt || null,
        };
      });
  } catch (err) {
    console.error(`[aiSearch:extract] Failed for ${pageUrl}:`, err.message);
    return [];
  }
}

module.exports = { extractJobsFromPage, preparePageTextForAI };
