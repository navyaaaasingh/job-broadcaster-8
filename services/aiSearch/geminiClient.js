const axios = require('axios');

// Gemini model names have churned frequently — if the configured model
// 404s (deprecated, renamed, or not available to this API key), try these
// in order rather than failing the whole request outright.
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];

async function callGeminiOnce(model, prompt, jsonMode, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: 'application/json' };
  }

  const { data } = await axios.post(url, body, {
    timeout: 60000,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }
  return text;
}

/**
 * Call Gemini's generateContent endpoint with a plain text prompt and
 * return the plain text response. Used by both the query planner (prompt
 * -> search queries) and the job extractor (page text -> structured JSON).
 *
 * Requires GEMINI_API_KEY. Tries the configured GEMINI_MODEL first, then
 * falls back through FALLBACK_MODELS on a 404 specifically (model not
 * found — a real, recurring issue as Google renames/retires models), so
 * one stale model name doesn't take down the whole search. Other error
 * types (auth, rate limit, etc.) are NOT retried across models, since
 * that wouldn't fix them.
 */
async function callGemini(prompt, { jsonMode = false } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set.');
  }

  const configured = process.env.GEMINI_MODEL;
  const modelsToTry = [configured, ...FALLBACK_MODELS].filter(
    (m, i, arr) => m && arr.indexOf(m) === i // dedupe, drop empty
  );

  let lastErr;
  for (const model of modelsToTry) {
    try {
      const result = await callGeminiOnce(model, prompt, jsonMode, apiKey);
      if (model !== modelsToTry[0]) {
        console.warn(`[gemini] Configured/primary model failed, succeeded with fallback model "${model}".`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err.response?.status !== 404) throw err; // only retry across models on 404
      console.warn(`[gemini] Model "${model}" not found (404), trying next fallback...`);
    }
  }
  throw lastErr;
}

module.exports = { callGemini };
