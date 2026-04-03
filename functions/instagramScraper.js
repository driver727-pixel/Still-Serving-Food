'use strict';

/**
 * instagramScraper.js
 *
 * Optional real-time enrichment: scrape a venue's Instagram business page for
 * recent posts that announce food-service hours.
 *
 * Many restaurants post "last call for food", "kitchen closes at 10", or
 * "food until midnight" on Instagram, often more promptly than updating their
 * own website or Facebook page.
 *
 * Uses Apify's `apify/instagram-scraper` actor (requires APIFY_API_KEY).
 * Without an Apify key this module returns an empty result — Instagram's
 * anti-bot defences make headless-browser scraping unreliable, so Apify's
 * managed browser pool is the only practical option.
 *
 * The Instagram URL for a venue must be resolved beforehand by
 * `resolveInstagramUrl()` in facebookResolver.js.
 */

const https = require('https');
const { parseHours, detect24Hours, isCurrentlyServing, formatTime } = require('./hoursParser');

const APIFY_RUN_URL =
  'https://api.apify.com/v2/acts/apify~instagram-scraper/runs';
const APIFY_DATASET_URL = 'https://api.apify.com/v2/datasets';

/** Max number of recent Instagram posts to fetch. */
const MAX_POSTS = 5;

/**
 * Keywords that mark an Instagram post as likely to contain kitchen/food
 * service hour information.
 */
const FOOD_HOURS_SIGNAL_RE =
  /\b(?:kitchen|grill|food|hot\s+food|last\s+orders?|last\s+call|hot\s+kitchen)\b/i;

// ---------------------------------------------------------------------------
// HTTP helpers (shared pattern with facebookScraper.js)
// ---------------------------------------------------------------------------

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
          reject(new Error(`Apify Instagram response parse error: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

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
            reject(new Error(`Apify dataset parse error: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Apify Instagram scraper
// ---------------------------------------------------------------------------

/**
 * Run Apify's Instagram Scraper actor for the given profile URL.
 * Returns up to MAX_POSTS recent post captions.
 *
 * @param {string} igUrl
 * @param {string} apifyKey
 * @returns {Promise<string[]>}  Array of post caption strings
 */
async function fetchInstagramPostsWithApify(igUrl, apifyKey) {
  const payload = JSON.stringify({
    directUrls: [igUrl],
    resultsType: 'posts',
    resultsLimit: MAX_POSTS,
    // Omit comments and stories to reduce actor execution time
    addParentData: false,
    isUserTaggedFeedURL: false,
  });

  const runUrl =
    `${APIFY_RUN_URL}?token=${encodeURIComponent(apifyKey)}&waitForFinish=120`;
  const runResponse = await httpPost(runUrl, payload);

  const datasetId = runResponse?.data?.defaultDatasetId;
  if (!datasetId) {
    throw new Error('Apify Instagram run did not return a dataset ID.');
  }

  const datasetUrl =
    `${APIFY_DATASET_URL}/${encodeURIComponent(datasetId)}/items` +
    `?token=${encodeURIComponent(apifyKey)}`;
  const items = await httpGet(datasetUrl);

  const posts = Array.isArray(items) ? items : [];
  return posts
    .map((item) => (typeof item === 'string' ? item : item?.caption || item?.text || ''))
    .filter(Boolean)
    .slice(0, MAX_POSTS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a venue's Instagram business page for recent posts that announce
 * food-service hours.
 *
 * Requires APIFY_API_KEY (via options or env var).  Returns an empty result
 * when no key is available rather than throwing, so the pipeline can proceed
 * with other sources.
 *
 * @param {string} igUrl  Canonical Instagram profile URL (e.g. "https://www.instagram.com/thepub")
 * @param {object} [options]
 * @param {string} [options.apifyApiKey]  Overrides APIFY_API_KEY env var
 * @param {Date}   [options.now]          Reference time for open/closed determination
 * @returns {Promise<{igUrl:string, recentPosts:string[], hourBlocks:object[], is24Hours:boolean, serving:boolean, opensAt:string|null, closesAt:string|null, hoursSource:string|null}>}
 */
async function scrapeInstagramPage(igUrl, options = {}) {
  const apifyKey = options.apifyApiKey || process.env.APIFY_API_KEY;
  const now = options.now || new Date();

  const EMPTY = {
    igUrl,
    recentPosts: [],
    hourBlocks: [],
    is24Hours: false,
    serving: false,
    opensAt: null,
    closesAt: null,
    hoursSource: null,
  };

  if (!apifyKey) return EMPTY;

  let recentPosts = [];
  try {
    recentPosts = await fetchInstagramPostsWithApify(igUrl, apifyKey);
  } catch {
    return EMPTY;
  }

  // Only parse posts that contain food/kitchen hour keywords — this avoids
  // the hoursParser incorrectly extracting unrelated time references (e.g.
  // "open at 9 for brunch" in a photo caption about the vibe).
  const foodPosts = recentPosts.filter((p) => FOOD_HOURS_SIGNAL_RE.test(p));
  const combinedText = foodPosts.join('\n');

  const is24Hours = detect24Hours(combinedText);
  const hourBlocks = parseHours(combinedText);
  const status = is24Hours
    ? { serving: true, opensAt: null, closesAt: null }
    : isCurrentlyServing(hourBlocks, now);

  const hoursSource =
    hourBlocks.length > 0 || is24Hours ? 'instagram_post' : null;

  return {
    igUrl,
    recentPosts,
    hourBlocks,
    is24Hours,
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    hoursSource,
  };
}

module.exports = { scrapeInstagramPage };
