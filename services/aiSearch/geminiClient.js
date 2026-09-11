const axios = require('axios');

// Gemini model names have churned frequently — if the configured model
// 404s (deprecated, renamed, or unavailable to this API key), try these
// in order rather than failing the whole request outright.
const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
];

// The current Free-tier project limit shown in AI Studio is 5 RPM.
// 12.5s between request starts keeps the process below that ceiling.
const MIN_REQUEST_INTERVAL_MS = 12500;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 15000;

let lastGeminiRequestAt = 0;
let requestQueue = Promise.resolve();

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function getGeminiErrorCode(err) {
  return String(
    err.response?.data?.error?.status ||
      err.response?.data?.error?.code ||
      ''
  ).toLowerCase();
}

async function callGeminiWithRetry(model, prompt, jsonMode, apiKey) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGeminiOnce(model, prompt, jsonMode, apiKey);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const errorCode = getGeminiErrorCode(err);

      if (!RETRYABLE_STATUS_CODES.has(status)) {
        throw err;
      }

      // A daily quota error will not recover by retrying. Do not burn more
      // requests or wait through backoffs when the quota is already exhausted.
      if (status === 429 && errorCode === 'quota_exceeded') {
        console.error(`[gemini] Model "${model}" hit its daily quota; not retrying.`);
        throw err;
      }

      if (attempt === MAX_RETRIES) {
        console.error(
          `[gemini] Model "${model}" failed after ${MAX_RETRIES + 1} attempts with status ${status}.`
        );
        throw err;
      }

      const retryAfterHeader = err.response?.headers?.['retry-after'];
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(0, retryAfterSeconds * 1000)
        : 0;

      const exponentialDelay = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, attempt),
        MAX_BACKOFF_MS
      );
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.max(exponentialDelay + jitter, retryAfterMs);

      console.warn(
        `[gemini] Model "${model}" returned ${status}. ` +
          `Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`
      );

      await sleep(delay);
    }
  }

  throw lastErr;
}

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
          `[gemini] Configured/primary model failed, succeeded with fallback model "${model}".`
        );
      }

      return result;
    } catch (err) {
      lastErr = err;

      // Only fall back for a model that does not exist. Do not switch models
      // after a 429: another model request can still consume project quota,
      // and the correct response to a rate limit is to wait/retry.
      if (err.response?.status !== 404) {
        throw err;
      }

      console.warn(
        `[gemini] Model "${model}" not found (404), trying next fallback...`
      );
    }
  }

  throw lastErr;
}

module.exports = { callGemini };
