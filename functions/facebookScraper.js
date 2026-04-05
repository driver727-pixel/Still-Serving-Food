'use strict';

/**
 * facebookScraper.js
 *
 * Phase 3 of the hybrid pipeline: Targeted Facebook Extraction.
 *
 * Given a Facebook business-page URL discovered in Phase 2, extract:
 *   • "About" section text  → permanent kitchen hours
 *   • Up to 3 recent posts  → real-time updates ("Kitchen closing early tonight!")
 *
 * ─── Firecrawl vs Apify ────────────────────────────────────────────────────
 *
 * Firecrawl uses headless Chrome, which renders JavaScript and gives it a
 * better chance of reading public Facebook pages than a plain HTTP fetch.
 * Public Facebook business pages do render some content without a login,
 * including the About section and recent posts on the page's timeline.
 *
 * However, Facebook aggressively detects and blocks automated browsers:
 *   • Pages frequently redirect unauthenticated bots to a login wall.
 *   • The rendered DOM structure changes without notice.
 *   • Rate-limiting kicks in after a small number of requests.
 *
 * RECOMMENDATION: Use Firecrawl as a best-effort fallback for low-volume
 * queries, but set APIFY_API_KEY to use Apify's dedicated Facebook Pages
 * Scraper actor (apify/facebook-pages-scraper) for production workloads.
 * Apify maintains browser fingerprint pools and session rotation specifically
 * designed to circumvent Facebook's bot-detection, making it significantly
 * more reliable for this use case.
 *
 * Set APIFY_API_KEY in .env to enable the Apify path automatically.
 * ───────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const FirecrawlApp = require('@mendable/firecrawl-js').default;
const { parseHours, detect24Hours, isCurrentlyServing, formatTime } = require('./hoursParser');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Perform an HTTPS POST with a JSON body and return the parsed JSON response.
 * @param {string} url
 * @param {string} jsonBody  Serialised JSON string
 * @returns {Promise<object>}
 */
function httpPost(url, jsonBody) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.from(jsonBody, 'utf8');
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length,
      },
    };
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Apify response JSON parse error: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Perform an HTTPS GET and return the parsed JSON response.
 * @param {string} url
 * @returns {Promise<object>}
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Apify dataset JSON parse error: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Apify integration
// ---------------------------------------------------------------------------

const APIFY_RUN_URL =
  'https://api.apify.com/v2/acts/apify~facebook-pages-scraper/runs';
const APIFY_DATASET_URL = 'https://api.apify.com/v2/datasets';

/**
 * Run Apify's Facebook Pages Scraper actor synchronously (waits up to 120 s).
 * Returns the About text and up to 3 recent post strings.
 *
 * @param {string} fbUrl
 * @param {string} apifyKey
 * @returns {Promise<{aboutText: string, recentPosts: string[]}>}
 */
async function scrapeWithApify(fbUrl, apifyKey) {
  const payload = JSON.stringify({
    startUrls: [{ url: fbUrl }],
    maxPosts: 3,
    maxPostComments: 0,
    maxReviews: 0,
    scrapeAbout: true,
  });

  // POST to start the run and wait for it to finish (synchronous endpoint)
  const runUrl = `${APIFY_RUN_URL}?token=${encodeURIComponent(apifyKey)}&waitForFinish=25`;
  const runResponse = await httpPost(runUrl, payload);

  const datasetId = runResponse?.data?.defaultDatasetId;
  if (!datasetId) {
    throw new Error('Apify run did not return a dataset ID.');
  }

  // Fetch dataset items
  const datasetUrl = `${APIFY_DATASET_URL}/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(apifyKey)}`;
  const datasetResponse = await httpGet(datasetUrl);

  const items = Array.isArray(datasetResponse) ? datasetResponse : [];
  const page = items[0] || {};

  const aboutText = [
    page.about || '',
    page.description || '',
    page.hours ? JSON.stringify(page.hours) : '',
  ]
    .filter(Boolean)
    .join('\n');

  const recentPosts = (page.posts || [])
    .slice(0, 3)
    .map((p) => (typeof p === 'string' ? p : p.text || p.message || ''))
    .filter(Boolean);

  return { aboutText, recentPosts };
}

// ---------------------------------------------------------------------------
// Firecrawl integration
// ---------------------------------------------------------------------------

/** Patterns that indicate we hit a Facebook login wall rather than the page. */
const LOGIN_WALL_RE =
  /log\s*in\s*to\s*facebook|create\s*a\s*new\s*account|you\s*must\s*be\s*logged\s*in|sign\s*in\s*to\s*continue|facebook.*requires.*login/i;

/**
 * Scrape a Facebook business page using Firecrawl's headless Chrome renderer.
 *
 * Facebook's public business pages are partially accessible without login.
 * Firecrawl's JavaScript rendering improves the hit rate compared to a raw
 * HTTP fetch, but results are not guaranteed — see the module-level note.
 *
 * @param {string} fbUrl
 * @param {string} apiKey  Firecrawl API key
 * @returns {Promise<{aboutText: string, recentPosts: string[], hitLoginWall: boolean}>}
 */
async function scrapeWithFirecrawl(fbUrl, apiKey) {
  const client = new FirecrawlApp({ apiKey });

  let result;
  try {
    result = await client.scrape(fbUrl, { formats: ['markdown'] });
  } catch {
    return { aboutText: '', recentPosts: [], hitLoginWall: false };
  }

  const text = result.markdown || '';

  if (LOGIN_WALL_RE.test(text)) {
    return { aboutText: '', recentPosts: [], hitLoginWall: true };
  }

  // Extract the "About" section: look for a heading/label followed by content
  const aboutMatch = text.match(/\babout\b[\s\S]{0,2000}/i);
  const aboutText = aboutMatch ? aboutMatch[0].slice(0, 1500) : text.slice(0, 1000);

  // Extract post-like paragraphs: short blocks without table/header formatting
  const recentPosts = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.length >= 20 &&
        block.length <= 500 &&
        !/^[|#\-=*>]/.test(block),
    )
    .slice(0, 3);

  return { aboutText, recentPosts, hitLoginWall: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a Facebook business page for kitchen hours and recent posts.
 *
 * Uses Apify when APIFY_API_KEY is configured (recommended for production),
 * otherwise falls back to Firecrawl.
 *
 * @param {string} fbUrl  Canonical Facebook page URL
 * @param {object} [options]
 * @param {string} [options.firecrawlApiKey]
 * @param {string} [options.apifyApiKey]
 * @param {Date}   [options.now]  Reference time for open/closed determination
 * @returns {Promise<FacebookResult>}
 */
async function scrapeFacebookPage(fbUrl, options = {}) {
  const firecrawlKey = options.firecrawlApiKey || process.env.FIRECRAWL_API_KEY;
  const apifyKey = options.apifyApiKey || process.env.APIFY_API_KEY;
  const now = options.now || new Date();

  let aboutText = '';
  let recentPosts = [];
  let hitLoginWall = false;
  let scraper = 'firecrawl';

  if (apifyKey) {
    scraper = 'apify';
    try {
      ({ aboutText, recentPosts } = await scrapeWithApify(fbUrl, apifyKey));
    } catch {
      // Apify failed — fall through to Firecrawl
      scraper = 'firecrawl';
    }
  }

  if (scraper === 'firecrawl') {
    if (!firecrawlKey) {
      return {
        facebookUrl: fbUrl,
        aboutText: '',
        recentPosts: [],
        hitLoginWall: false,
        scraper: 'none',
        hourBlocks: [],
        is24Hours: false,
        serving: false,
        opensAt: null,
        closesAt: null,
        hoursSource: null,
      };
    }
    ({ aboutText, recentPosts, hitLoginWall } = await scrapeWithFirecrawl(fbUrl, firecrawlKey));
  }

  // Parse hours from the combined About text and recent posts
  const combinedText = [aboutText, ...recentPosts].join('\n');
  const is24Hours = detect24Hours(combinedText);
  const hourBlocks = parseHours(combinedText);
  const status = is24Hours
    ? { serving: true, opensAt: null, closesAt: null }
    : isCurrentlyServing(hourBlocks, now);

  // Determine the hours data source for the frontend tag
  let hoursSource = null;
  if (hourBlocks.length > 0 || is24Hours) {
    const postHourBlocks = parseHours(recentPosts.join('\n'));
    hoursSource = postHourBlocks.length > 0 ? 'facebook_post' : 'facebook_about';
  }

  return {
    facebookUrl: fbUrl,
    aboutText,
    recentPosts,
    hitLoginWall,
    scraper,
    hourBlocks,
    is24Hours,
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    hoursSource,
  };
}

module.exports = { scrapeFacebookPage };
