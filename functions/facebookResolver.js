'use strict';

/**
 * facebookResolver.js
 *
 * Phase 2 of the hybrid pipeline: Social URL Resolution.
 *
 * For each business entity retrieved in Phase 1, find its Facebook and
 * Instagram page URLs using a two-step strategy:
 *
 *   Fast path  – The `website` field from Google Places IS a Facebook/Instagram page.
 *   Slow path  – Scrape the business homepage with Firecrawl and extract
 *                any Facebook or Instagram page link from the rendered HTML/links list.
 *
 * Excluded URL patterns (share dialogs, login pages, policy pages, etc.) are
 * filtered out so that only canonical business-page URLs are returned.
 */

const FirecrawlApp = require('@mendable/firecrawl-js').default;

/**
 * Matches a canonical Facebook business-page URL.
 * Excludes share dialogs, login, help, policy, and marketplace paths.
 * Used for exact URL testing (isFacebookUrl) — no end anchor so it can also
 * be used to search within larger text strings.
 */
const FB_PAGE_RE =
  /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer\b|share\b|dialog\b|login\b|help\b|policies\b|legal\b|privacy\b|terms\b|events\/|groups\/|marketplace\b)([A-Za-z0-9._-]+)\/?(?:[?#][^\s)]*)?/i;

/**
 * Return true when the URL is a Facebook business page (not a share dialog,
 * login wall, or other non-page path).
 * @param {string} url
 * @returns {boolean}
 */
function isFacebookUrl(url) {
  if (typeof url !== 'string') return false;
  return FB_PAGE_RE.test(url);
}

/**
 * Normalise a Facebook URL to a canonical page URL (strips query-strings,
 * fragments, and trailing slashes).
 * @param {string} url
 * @returns {string|null}
 */
function normaliseFacebookUrl(url) {
  const match = url.match(FB_PAGE_RE);
  if (!match) return null;
  return `https://www.facebook.com/${match[1]}`;
}

/**
 * Scrape the given website homepage with Firecrawl and extract the first
 * Facebook business-page link from either the links array or the markdown text.
 *
 * @param {string} websiteUrl
 * @param {string} apiKey  Firecrawl API key
 * @returns {Promise<string|null>}
 */
async function extractFacebookFromWebsite(websiteUrl, apiKey) {
  const client = new FirecrawlApp({ apiKey });

  let result;
  try {
    result = await client.scrape(websiteUrl, { formats: ['links', 'markdown'] });
  } catch {
    return null;
  }

  // Check the structured links array first (most reliable)
  const links = result.links || [];
  for (const link of links) {
    if (typeof link === 'string' && isFacebookUrl(link)) {
      return normaliseFacebookUrl(link);
    }
    // Some Firecrawl versions return link objects with a `url` property
    if (link && typeof link.url === 'string' && isFacebookUrl(link.url)) {
      return normaliseFacebookUrl(link.url);
    }
  }

  // Fall back to scanning markdown text for an embedded Facebook URL
  const text = result.markdown || '';
  const match = text.match(FB_PAGE_RE);
  return match ? normaliseFacebookUrl(match[0]) : null;
}

// ---------------------------------------------------------------------------
// Instagram URL helpers
// ---------------------------------------------------------------------------

/**
 * Matches a canonical Instagram business-page URL.
 * Excludes posts (/p/), reels (/reel/), stories (/stories/), explore (/explore/),
 * accounts (/accounts/), and tags (/tags/) paths.
 */
const IG_PAGE_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|stories\/|explore\/|accounts\/|tags\/|tv\/)([A-Za-z0-9._]+)\/?(?:[?#][^\s)]*)?/i;

/**
 * Return true when the URL is an Instagram business/creator page (not a post,
 * reel, story, or other non-profile path).
 * @param {string} url
 * @returns {boolean}
 */
function isInstagramUrl(url) {
  if (typeof url !== 'string') return false;
  return IG_PAGE_RE.test(url);
}

/**
 * Normalise an Instagram URL to a canonical profile URL (strips query-strings,
 * fragments, and trailing slashes).
 * @param {string} url
 * @returns {string|null}
 */
function normaliseInstagramUrl(url) {
  const match = url.match(IG_PAGE_RE);
  if (!match) return null;
  return `https://www.instagram.com/${match[1]}`;
}

/**
 * Scrape the given website homepage with Firecrawl and extract the first
 * Instagram business-page link from either the links array or the markdown text.
 *
 * @param {string} websiteUrl
 * @param {string} apiKey  Firecrawl API key
 * @returns {Promise<string|null>}
 */
async function extractInstagramFromWebsite(websiteUrl, apiKey) {
  // Re-use the same scraped result that extractFacebookFromWebsite uses when
  // both are called for the same venue.  To avoid a second network request,
  // scrape only once here when called independently.
  const client = new FirecrawlApp({ apiKey });

  let result;
  try {
    result = await client.scrape(websiteUrl, { formats: ['links', 'markdown'] });
  } catch {
    return null;
  }

  const links = result.links || [];
  for (const link of links) {
    const href = typeof link === 'string' ? link : link?.url;
    if (typeof href === 'string' && isInstagramUrl(href)) {
      return normaliseInstagramUrl(href);
    }
  }

  const text = result.markdown || '';
  const match = text.match(IG_PAGE_RE);
  return match ? normaliseInstagramUrl(match[0]) : null;
}

/**
 * Resolve the Instagram business-page URL for a place entity.
 *
 * @param {object} place   A PlaceResult from placesClient (must have `website`)
 * @param {string} apiKey  Firecrawl API key (used for homepage scraping)
 * @returns {Promise<string|null>} Canonical Instagram page URL, or null
 */
async function resolveInstagramUrl(place, apiKey) {
  const { website } = place;
  if (!website) return null;

  // Fast path: the website field IS already an Instagram page
  if (isInstagramUrl(website)) {
    return normaliseInstagramUrl(website);
  }

  // Slow path: scrape the homepage and look for an Instagram social link
  return extractInstagramFromWebsite(website, apiKey);
}

/**
 * Resolve the Facebook business-page URL for a place entity.
 *
 * @param {object} place   A PlaceResult from placesClient (must have `website`)
 * @param {string} apiKey  Firecrawl API key (used for homepage scraping)
 * @returns {Promise<string|null>} Canonical Facebook page URL, or null
 */
async function resolveFacebookUrl(place, apiKey) {
  const { website } = place;
  if (!website) return null;

  // Fast path: the website field IS already a Facebook page
  if (isFacebookUrl(website)) {
    return normaliseFacebookUrl(website);
  }

  // Slow path: scrape the homepage and look for a Facebook social link
  return extractFacebookFromWebsite(website, apiKey);
}

module.exports = {
  resolveFacebookUrl, isFacebookUrl, normaliseFacebookUrl,
  resolveInstagramUrl, isInstagramUrl, normaliseInstagramUrl,
};
