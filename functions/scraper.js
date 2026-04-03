'use strict';

/**
 * scraper.js
 *
 * Wraps the Firecrawl SDK to:
 *   1. Search for restaurant/bar websites in a given location.
 *   2. Scrape each venue's website for food-service hours.
 *   3. Return structured venue objects ready for display.
 */

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const { parseHours, isCurrentlyServing, formatTime, detect24Hours } = require('./hoursParser');

// ---------------------------------------------------------------------------
// Relevance filtering — keep only commercial restaurant/food-truck pages
// ---------------------------------------------------------------------------

/** Individual social media posts (not business pages). */
const SOCIAL_POST_URL_RE = /instagram\.com\/p\/|twitter\.com\/[^/]+\/status\/|x\.com\/[^/]+\/status\//i;

/** Aggregator search-result pages (not individual business listings). */
const AGGREGATOR_SEARCH_URL_RE = /yelp\.com\/search|tripadvisor\.com\/Restaurants-g/i;

/** Listicle / guide URL path segments. */
const LISTICLE_URL_RE = /\/(top[-_]?\d+|best[-_]restaurants|things[-_]to[-_]do|food[-_]guide|where[-_]to[-_]eat)/i;

/** Private-event / catering-only language in page content. */
const PRIVATE_EVENT_RE = /\bprivate\s+(?:event|catering|party|parties)\b|\bcatering\s+only\b/i;

/** Accommodation keywords in the page title (signals a hotel / inn / etc.). */
const HOTEL_NAME_RE = /\b(hotel|inn|resort|motel|lodge|hostel|suites?|bed\s+(?:and|&)\s+breakfast|b\s*&?\s*b)\b/i;

/** Food-service keywords that indicate a restaurant inside or alongside accommodation. */
const FOOD_BUSINESS_RE = /\b(restaurant|food\s+truck|diner|cafe|caf[eé]|bistro|brasserie|grill|kitchen|pub|bar|eatery|pizzeria)\b/i;

/**
 * Return true only when the raw Firecrawl result looks like a commercial
 * restaurant or food-truck business page.  Filters out:
 *   - Individual social-media posts (Instagram /p/, Twitter /status/)
 *   - Aggregator search-result pages (Yelp /search, TripAdvisor list pages)
 *   - Listicle / "Top 10" guide pages
 *   - Private-event / catering-only venues
 *   - Bare accommodation pages with no food-service mention
 * @param {object} raw  Raw Firecrawl result object
 * @returns {boolean}
 */
function isVenueRelevant(raw) {
  const url = raw.url || '';
  const title = raw.metadata?.title || raw.title || '';
  const text = [
    raw.markdown || '',
    raw.content || '',
    raw.description || '',
    raw.metadata?.description || '',
  ].join('\n');

  if (SOCIAL_POST_URL_RE.test(url)) return false;
  if (AGGREGATOR_SEARCH_URL_RE.test(url)) return false;
  if (LISTICLE_URL_RE.test(url)) return false;
  if (PRIVATE_EVENT_RE.test(text)) return false;

  // Drop pure accommodation pages that carry no food-service signals
  if (HOTEL_NAME_RE.test(title) && !FOOD_BUSINESS_RE.test(title) && !FOOD_BUSINESS_RE.test(text)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// "Call for hours" / late-service detection
// ---------------------------------------------------------------------------

/**
 * Phrases that indicate a venue's hours are uncertain or need confirmation,
 * or that the venue is known for late-night / variable service.
 */
const CALL_FOR_HOURS_RE =
  /\b(call\s+(?:ahead|us|for\s+hours?|to\s+confirm)|hours?\s+(?:vary|may\s+vary|are\s+seasonal)|seasonal\s+hours?|by\s+appointment|serving\s+late|late[\s-]night\s+(?:menu|service|hours?)|open\s+late)\b/i;

/**
 * Build and return a Firecrawl client.
 * @param {string} apiKey
 * @returns {FirecrawlApp}
 */
function buildClient(apiKey) {
  return new FirecrawlApp({ apiKey });
}

/**
 * Build a search query string from the given search parameters.
 * The query targets commercial restaurant / food-truck business pages
 * (including Yelp listings and Facebook business pages) and avoids
 * "Top 10" listicle articles, hotel accommodation pages, and social posts.
 * @param {object} params
 * @param {string} [params.location]
 * @param {string} [params.name]
 * @param {string} [params.servingUntil]
 * @returns {string}
 */
function buildQuery(params = {}) {
  const parts = [];

  if (params.name && params.name.trim()) {
    parts.push(`"${params.name.trim()}"`);
  }

  if (params.location && params.location.trim()) {
    parts.push(`"${params.location.trim()}"`);
  }

  // Restrict to commercial food-service venue types so we avoid hotel
  // accommodation pages, private-event spaces, and generic listicles.
  const venueTypes = [
    'restaurant',
    '"food truck"',
    'diner',
    'cafe',
    'bistro',
    'pub',
    'bar',
    'grill',
  ];
  parts.push(`(${venueTypes.join(' OR ')})`);

  // Use specific food-service-hours phrases that appear on actual restaurant
  // pages, Yelp listings, and Facebook business pages — not in listicle articles.
  const foodHoursPhrases = [
    '"food hours"',
    '"kitchen hours"',
    '"grill hours"',
    '"serving hours"',
    '"hot food hours"',
    '"open 24 hours"',
    '"24/7"',
    '"delivery hours"',
    '"pickup hours"',
  ];
  parts.push(`(${foodHoursPhrases.join(' OR ')})`);

  if (params.servingUntil && params.servingUntil.trim()) {
    parts.push(`serving until ${params.servingUntil.trim()}`);
  }

  return parts.join(' ');
}

/**
 * Use Firecrawl's /search endpoint to find restaurant & bar pages matching
 * the given search parameters, then scrape each result for food-service hours.
 *
 * @param {object} searchParams
 * @param {string} [searchParams.location] - E.g. "Brooklyn, NY"
 * @param {string} [searchParams.name]     - E.g. "The Crown & Anchor"
 * @param {string} [searchParams.servingUntil] - E.g. "10pm"
 * @param {object} [options]
 * @param {string} [options.apiKey] - Overrides process.env.FIRECRAWL_API_KEY
 * @param {number} [options.limit=10] - Max number of venues to process
 * @returns {Promise<Venue[]>}
 */
async function searchVenues(searchParams, options = {}) {
  // Back-compat: allow passing a plain location string
  if (typeof searchParams === 'string') {
    searchParams = { location: searchParams };
  }

  const apiKey = options.apiKey || process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set. Add it to your .env file.');
  }

  const limit = options.limit || 10;
  const client = buildClient(apiKey);

  const query = buildQuery(searchParams);

  let searchResults;
  try {
    searchResults = await client.search(query, {
      limit,
      scrapeOptions: { formats: ['markdown'] },
    });
  } catch (err) {
    throw new Error(`Firecrawl search failed: ${err.message}`);
  }

  if (!searchResults || !Array.isArray(searchResults.web)) {
    return [];
  }

  const venues = searchResults.web
    .filter((result) => isVenueRelevant(result))
    .map((result) => buildVenue(result));
  return venues;
}

/**
 * Scrape a specific URL for food-service hours.
 *
 * @param {string} url - The venue website URL
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @returns {Promise<Venue>}
 */
async function scrapeVenue(url, options = {}) {
  const apiKey = options.apiKey || process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set. Add it to your .env file.');
  }

  const client = buildClient(apiKey);

  let result;
  try {
    result = await client.scrape(url, {
      formats: ['markdown'],
    });
  } catch (err) {
    throw new Error(`Firecrawl scrape failed for ${url}: ${err.message}`);
  }

  return buildVenue({ url, ...result });
}

/**
 * Convert a raw Firecrawl result into a structured Venue object.
 * @param {object} raw
 * @returns {Venue}
 */
function buildVenue(raw) {
  const text = [raw.markdown || '', raw.content || '', raw.description || ''].join('\n');
  const is24Hours = detect24Hours(text);
  const hourBlocks = parseHours(text);

  // 24-hour establishments are always serving; skip the time-window check.
  const status = is24Hours
    ? { serving: true, opensAt: null, closesAt: null }
    : isCurrentlyServing(hourBlocks);

  // Derive a display name: prefer metadata title, fall back to hostname
  let name = raw.metadata?.title || raw.title || '';
  if (!name && raw.url) {
    try {
      name = new URL(raw.url).hostname.replace(/^www\./, '');
    } catch (_) {
      name = raw.url;
    }
  }
  name = name.split(' | ')[0].split(' - ')[0].trim() || 'Unknown Venue';

  // Detect "call for hours" / late-service language so the UI can surface
  // a contact link prompting the user to reach out to confirm hours.
  const callForHours = CALL_FOR_HOURS_RE.test(text);

  return {
    name,
    url: raw.url || '',
    description: raw.metadata?.description || raw.description || '',
    hourBlocks,
    is24Hours,
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    callForHours,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { searchVenues, scrapeVenue, buildVenue, isVenueRelevant, buildQuery };
