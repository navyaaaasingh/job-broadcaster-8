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
async function renderPage(url, { timeoutMs = 25000 } = {}) {
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

    // Deliberately NOT using waitUntil: 'networkidle' — it demands the page
    // go completely silent on the network for 500ms straight, and many
    // real sites (chat widgets, analytics beacons, ad trackers) never
    // actually reach that state, causing frequent false-timeout failures
    // on otherwise perfectly loaded pages. 'domcontentloaded' fires as
    // soon as the HTML itself is parsed — much more reliable in practice.
    let navTimedOut = false;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (navErr) {
      navTimedOut = true;
      console.warn(`[aiSearch:render] Navigation issue for ${url}, will still try reading whatever loaded:`, navErr.message);
    }

    // If navigation itself timed out, the page may still be mid-redirect —
    // give it a longer settle window before touching content(). If it
    // navigated cleanly, a shorter window is enough for JS-rendered
    // content (React/Vue job listings, etc.) to populate.
    await page.waitForTimeout(navTimedOut ? 3000 : 1500).catch(() => {});

    // page.content() throws "page is navigating and changing the content"
    // if called while a redirect/navigation is still actively in flight —
    // retry once after a short pause rather than failing the whole page
    // over what's often just bad timing.
    let html;
    try {
      html = await page.content();
    } catch (contentErr) {
      console.warn(`[aiSearch:render] content() collided with in-flight navigation for ${url}, retrying once...`);
      await page.waitForTimeout(2000).catch(() => {});
      html = await page.content();
    }
    return html;
  } catch (err) {
    console.warn(`[aiSearch:render] Failed to render ${url}:`, err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Render several URLs with limited concurrency (full browser pages are memory-heavy).
 * Concurrency defaults to 1 — sequential — since Render's free tier has
 * limited CPU/RAM, and running multiple full Chromium pages at once tends
 * to slow all of them down rather than genuinely parallelizing, often
 * pushing otherwise-fine pages past their timeout. Slower overall, but
 * more of what does render actually succeeds. */
async function renderMultiple(urls, { concurrency = 1 } = {}) {
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
