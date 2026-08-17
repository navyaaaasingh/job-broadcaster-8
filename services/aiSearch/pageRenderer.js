const { chromium } = require('playwright');
const { isFetchAllowed } = require('../webExtract/robotsCheck');

let browserPromise = null;

/**
 * Reuse a single browser instance across renders in the same search
 * (launching Chromium is the expensive part) rather than starting a fresh
 * one per page.
 */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // Reduce memory footprint — important on resource-constrained hosts
      // like Render's free tier, where a default Chromium launch can be
      // enough to hit the instance's RAM limit on its own.
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

/**
 * Render one URL with a real browser (so JavaScript-driven content loads)
 * and return the resulting HTML. Returns null on any failure — timeout,
 * robots.txt disallowing it, navigation error — so one bad page never
 * takes down the rest of a search.
 */
async function renderPage(url, { timeoutMs = 20000 } = {}) {
  const allowed = await isFetchAllowed(url);
  if (!allowed) {
    console.warn(`[aiSearch:render] Skipped ${url} — disallowed by robots.txt.`);
    return null;
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (compatible; JobBroadcaster/1.0)',
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const html = await page.content();
    return html;
  } catch (err) {
    console.warn(`[aiSearch:render] Failed to render ${url}:`, err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Render several URLs with limited concurrency (full browser pages are memory-heavy). */
async function renderMultiple(urls, { concurrency = 2 } = {}) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url) => ({ url, html: await renderPage(url) }))
    );
    results.push(...batchResults);
  }
  return results.filter((r) => r.html);
}

/** Call this once when the process is shutting down, to release the browser cleanly. */
async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = { renderPage, renderMultiple, closeBrowser };
