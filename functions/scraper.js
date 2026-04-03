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
 * The query is structured to surface actual restaurant / bar pages
 * (including Yelp and Facebook listings) rather than "Top 10" listicle articles.
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

  // Use specific food-service-hours phrases that appear on actual restaurant
  // pages, Yelp listings, and Facebook pages — not in "Top 10" listicle articles.
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
  parts.push(`restaurant ${foodHoursPhrases.join(' OR ')}`);

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

  const venues = searchResults.web.map((result) => buildVenue(result));
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

  return {
    name,
    url: raw.url || '',
    description: raw.metadata?.description || raw.description || '',
    hourBlocks,
    is24Hours,
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { searchVenues, scrapeVenue, buildVenue };
