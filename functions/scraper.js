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
const { parseHours, isCurrentlyServing, formatTime } = require('./hoursParser');

/**
 * Build and return a Firecrawl client.
 * @param {string} apiKey
 * @returns {FirecrawlApp}
 */
function buildClient(apiKey) {
  return new FirecrawlApp({ apiKey });
}

/**
 * Use Firecrawl's /search endpoint to find restaurant & bar pages for a
 * given location query, then scrape each result for food-service hours.
 *
 * @param {string} location - E.g. "Brooklyn, NY" or "Manchester, UK"
 * @param {object} [options]
 * @param {string} [options.apiKey] - Overrides process.env.FIRECRAWL_API_KEY
 * @param {number} [options.limit=10] - Max number of venues to process
 * @returns {Promise<Venue[]>}
 */
async function searchVenues(location, options = {}) {
  const apiKey = options.apiKey || process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set. Add it to your .env file.');
  }

  const limit = options.limit || 10;
  const client = buildClient(apiKey);

  const query = `bars restaurants grill food hours "${location}"`;

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
  const hourBlocks = parseHours(text);
  const status = isCurrentlyServing(hourBlocks);

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
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { searchVenues, scrapeVenue, buildVenue };
