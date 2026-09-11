const axios = require('axios');

// Gemini model names have churned frequently — if the configured model
// 404s (deprecated, renamed, or not available to this API key), try these
// in order rather than failing the whole request outright.
const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
];

// Retry configuration for transient Gemini errors.
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

// HTTP status codes that are generally safe to retry.
const RETRYABLE_STATUS_CODES = new Set([
  429, // Too Many Requests / rate limit
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Gemini once.
 */
async function callGeminiOnce(model, prompt, jsonMode, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  };

  if (jsonMode) {
    body.generationConfig = {
      responseMimeType: 'application/json',
    };
  }

  const { data } = await axios.post(url, body, {
    timeout: 60000,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  return text;
}

/**
 * Call Gemini with retry + exponential backoff.
 *
 * Retries transient errors such as:
 *   - 429 Rate Limit
 *   - 500 Internal Server Error
 *   - 502 Bad Gateway
 *   - 503 Service Unavailable
 *   - 504 Gateway Timeout
 *
 * Does NOT retry 404 here because 404 is handled by the model
 * fallback logic in callGemini().
 */
async function callGeminiWithRetry(model, prompt, jsonMode, apiKey) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGeminiOnce(model, prompt, jsonMode, apiKey);
    } catch (err) {
      lastErr = err;

      const status = err.response?.status;

      // Do not retry non-transient errors.
      if (!RETRYABLE_STATUS_CODES.has(status)) {
        throw err;
      }

      // If this was the final attempt, give up.
      if (attempt === MAX_RETRIES) {
        console.error(
          `[gemini] Model "${model}" failed after ${MAX_RETRIES + 1} attempts with status ${status}.`
        );
        throw err;
      }

      // Exponential backoff:
      // attempt 0 -> 1s
      // attempt 1 -> 2s
      // attempt 2 -> 4s
      //
      // Add a small amount of jitter so multiple requests don't
      // retry at exactly the same time.
      const exponentialDelay = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, attempt),
        MAX_BACKOFF_MS
      );

      const jitter = Math.floor(Math.random() * 250);
      const delay = exponentialDelay + jitter;

      console.warn(
        `[gemini] Model "${model}" returned ${status}. ` +
          `Retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES + 1})...`
      );

      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Call Gemini's generateContent endpoint with a plain text prompt and
 * return the plain text response. Used by both the query planner
 * (prompt -> search queries) and the job extractor
 * (page text -> structured JSON).
 *
 * Requires GEMINI_API_KEY.
 *
 * Behavior:
 * 1. Try GEMINI_MODEL first.
 * 2. Retry transient errors using exponential backoff.
 * 3. If the model returns 404, move to the next fallback model.
 * 4. Do not retry authentication/configuration errors.
 */
async function callGemini(prompt, { jsonMode = false } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set.');
  }

  const configured = process.env.GEMINI_MODEL;

  const modelsToTry = [configured, ...FALLBACK_MODELS].filter(
    (m, i, arr) => m && arr.indexOf(m) === i
  );

  let lastErr;

  for (const model of modelsToTry) {
    try {
      const result = await callGeminiWithRetry(
        model,
        prompt,
        jsonMode,
        apiKey
      );

      if (model !== modelsToTry[0]) {
        console.warn(
          `[gemini] Configured/primary model failed, ` +
            `succeeded with fallback model "${model}".`
        );
      }

      return result;
    } catch (err) {
      lastErr = err;

      // Only move to the next model on 404.
      // 503/429/5xx have already been retried by callGeminiWithRetry().
      if (err.response?.status !== 404) {
        throw err;
      }

      console.warn(
        `[gemini] Model "${model}" not found (404), ` +
          `trying next fallback...`
      );
    }
  }

  throw lastErr;
}

module.exports = { callGemini };
