const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Strip a page down to a reasonably-sized, link-preserving text blob for
 * the AI to read. We keep <a href> markup (as [text](href)) rather than
 * plain text, since job listing pages are mostly identified by their
 * apply links — losing those would make extraction useless.
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
  // Cap length to keep the AI call fast and cheap — job listing pages
  // rarely need more than this to extract what's visible.
  return text.slice(0, 12000);
}

/**
 * Ask an LLM to extract job postings from a page's text when no structured
 * data was found. Requires ANTHROPIC_API_KEY. Returns a normalized job
 * array, or an empty array if extraction fails or finds nothing — this is
 * a best-effort fallback, not a guaranteed source, so failures here should
 * never break the overall search.
 */
async function extractJobsWithAI(html, pageUrl, sourceId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[webExtract:${sourceId}] Skipped AI extraction: ANTHROPIC_API_KEY not set.`);
    return [];
  }

  const pageText = preparePageTextForAI(html);
  if (!pageText) return [];

  const prompt = `Below is text extracted from a job listings webpage, with links preserved as [link text](url).

Extract every genuine job posting you can find. Return ONLY a JSON array (no other text, no markdown fences) where each item has exactly these fields:
{"title": string, "company": string or null, "location": string or null, "description": string or null, "url": string or null, "salaryMin": number or null, "salaryMax": number or null, "postedAt": string or null}

Use the href from the closest relevant [text](url) link as the "url" field for each posting — it may be a relative path, that's fine, don't try to fix it. If there are no real job postings on this page, return an empty array [].

Page text:
${pageText}`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: process.env.AI_EXTRACT_MODEL || 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        timeout: 20000,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const textBlock = data.content?.find((b) => b.type === 'text');
    if (!textBlock) return [];

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const rawJobs = JSON.parse(cleaned);
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
          id: `${sourceId}:ai:${resolvedUrl}:${i}`,
          source: sourceId,
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
    console.error(`[webExtract:${sourceId}] AI extraction failed:`, err.response?.data || err.message);
    return [];
  }
}

module.exports = { extractJobsWithAI, preparePageTextForAI };
