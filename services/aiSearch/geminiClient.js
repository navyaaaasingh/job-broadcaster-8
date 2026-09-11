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

// Keep Gemini requests spaced out. Resume search can make several Gemini
// calls per candidate (profile + query planning + extraction), so firing
// them too quickly can exhaust per-minute request limits even when requests
// are processed sequentially at the application level.
const MIN_REQUEST_INTERVAL_MS = 4000;
let lastGeminiRequestAt = 0;
let requestQueue = Promise.resolve();

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
 * Serialize and throttle all Gemini requests in this Node process.
 * This prevents multiple resume/search operations from accidentally
 * bursting requests against Gemini's per-minute limits.
 */
async function waitForGeminiSlot() {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    const elapsed = Date.now() - lastGeminiRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastGeminiRequestAt = Date.now();
  } finally {
    release();
  }
}

/**
 * Call Gemini once.
 */
async function callGeminiOnce(model, prompt, jsonMode, apiKey) {
  await waitForGeminiSlot();

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

      // If this was the final attempt, give up and let callGemini()
      // decide whether another model should be tried.
      if (attempt === MAX_RETRIES) {
        console.error(
          `[gemini] Model "${model}" failed after ${MAX_RETRIES + 1} attempts with status ${status}.`
        );
        throw err;
      }

      // Respect Gemini's Retry-After header when supplied. Otherwise use
      // exponential backoff with a small jitter.
      const retryAfterHeader = err.response?.headers?.['retry-after'];
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(0, retryAfterSeconds * 1000)
        : 0;

      const exponentialDelay = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, attempt),
        MAX_BACKOFF_MS
      );

      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.max(
        exponentialDelay + jitter,
        retryAfterMs
      );

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
 * 3. If the model returns 404 or exhausts 429 retries, move to the next
 *    fallback model.
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

      // Move to the next model for both an unavailable model (404) and an
      // exhausted rate limit (429). A model-specific limit may not affect
      // the fallback model, while all other errors should fail immediately.
      if (err.response?.status !== 404 && err.response?.status !== 429) {
        throw err;
      }

      if (err.response?.status === 404) {
        console.warn(
          `[gemini] Model "${model}" not found (404), ` +
            `trying next fallback...`
        );
      } else {
        console.warn(
          `[gemini] Model "${model}" is rate-limited (429) after retries, ` +
            `trying next fallback...`
        );
      }
    }
  }

  throw lastErr;
}

module.exports = { callGemini };
