'use strict';

/**
 * foursquareClient.js
 *
 * Optional enrichment source: Foursquare Places API v3.
 *
 * Foursquare provides structured hours for food establishments and also
 * exposes user-contributed "tips" which often contain real-world notes such as
 * "kitchen closes at 10 but the bar stays open until 2".
 *
 * Requires FOURSQUARE_API_KEY (set in .env).  Without it, this module returns
 * empty results and the pipeline falls through to other sources.
 *
 * References:
 *   https://docs.foursquare.com/developer/reference/place-search
 *   https://docs.foursquare.com/developer/reference/place-details
 */

const https = require('https');
const { parseHours, isCurrentlyServing, detect24Hours, formatTime } = require('./hoursParser');

const FSQ_SEARCH_URL = 'https://api.foursquare.com/v3/places/search';
const FSQ_DETAILS_BASE_URL = 'https://api.foursquare.com/v3/places';

/**
 * Foursquare "Food" top-level category ID.
 * Covers restaurants, bars, cafes, fast food, etc.
 */
const FOOD_CATEGORY_ID = '13000';

/** Maximum number of tip texts to include when enriching venues. */
const MAX_TIPS = 5;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Perform an HTTPS GET with Foursquare's Authorization header and return the
 * parsed JSON body.
 *
 * @param {string} url
 * @param {string} apiKey  Foursquare API key (e.g. "fsq3...")
 * @returns {Promise<object>}
 */
function httpGetFsq(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { Authorization: apiKey },
    };
    https
      .get(options, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Foursquare JSON parse error: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Hours conversion
// ---------------------------------------------------------------------------

/**
 * Convert Foursquare's structured hours response to HourBlocks.
 *
 * Foursquare v3 hours use ISO day-of-week numbering:
 *   1=Monday, 2=Tuesday, …, 6=Saturday, 7=Sunday
 *
 * Our HourBlock format uses JavaScript's getDay() convention:
 *   0=Sunday, 1=Monday, …, 6=Saturday
 *
 * Conversion: ourDay = foursquareDay % 7
 *
 * @param {object|null} fsqHours  Value of the `hours` field from a Foursquare place
 * @returns {Array<{day,open,close,label,inFoodSection}>}
 */
function parseFoursquareHoursToBlocks(fsqHours) {
  const DAY_LABELS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const regular = (fsqHours && Array.isArray(fsqHours.regular)) ? fsqHours.regular : [];

  const blocks = [];
  for (const slot of regular) {
    if (!slot || !slot.open || !slot.close) continue;
    // Foursquare day 1=Mon…7=Sun → JS day 0=Sun…6=Sat via modulo
    const day = slot.day % 7;
    const openStr = String(slot.open).padStart(4, '0');
    const closeStr = String(slot.close).padStart(4, '0');
    const open = parseInt(openStr.slice(0, 2), 10) * 60 + parseInt(openStr.slice(2, 4), 10);
    const close = parseInt(closeStr.slice(0, 2), 10) * 60 + parseInt(closeStr.slice(2, 4), 10);
    if (isNaN(open) || isNaN(close)) continue;
    blocks.push({ day, open, close, label: DAY_LABELS[day], inFoodSection: false });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetch place details (hours + tips) for a single Foursquare venue.
 *
 * @param {string} fsqId   Foursquare place ID
 * @param {string} apiKey
 * @returns {Promise<{hourBlocks: HourBlock[], tipTexts: string[]}|null>}
 */
async function fetchFoursquarePlaceDetails(fsqId, apiKey) {
  const url =
    `${FSQ_DETAILS_BASE_URL}/${encodeURIComponent(fsqId)}` +
    `?fields=name,hours,tips`;

  try {
    const data = await httpGetFsq(url, apiKey);
    if (data.message) return null; // API-level error response

    const hourBlocks = parseFoursquareHoursToBlocks(data.hours || null);

    // Collect tip texts that mention kitchen/food hours keywords
    const tips = Array.isArray(data.tips) ? data.tips : [];
    const tipTexts = tips
      .slice(0, MAX_TIPS)
      .map((t) => (typeof t === 'string' ? t : t?.text || ''))
      .filter(Boolean);

    return { hourBlocks, tipTexts };
  } catch {
    return null;
  }
}

/**
 * Search Foursquare for food establishments near the given location.
 *
 * Each result includes the place name, address, structured hour blocks, and
 * tip texts so that the caller can enrich existing venue data.
 *
 * @param {object} params
 * @param {string} params.location   Location string, e.g. "Brooklyn, NY"
 * @param {number} [params.limit=20] Max results to fetch
 * @param {string} [params.apiKey]   Overrides FOURSQUARE_API_KEY env var
 * @returns {Promise<Array<{name,address,hourBlocks,tipTexts}>>}
 */
async function searchFoursquareVenues({ location, limit = 20, apiKey } = {}) {
  const key = apiKey || process.env.FOURSQUARE_API_KEY;
  if (!key) {
    throw new Error('FOURSQUARE_API_KEY is not set.');
  }

  if (!location || !location.trim()) {
    throw new Error('A location string is required for Foursquare search.');
  }

  const searchUrl =
    `${FSQ_SEARCH_URL}` +
    `?query=restaurants+bars+cafes` +
    `&near=${encodeURIComponent(location.trim())}` +
    `&categories=${FOOD_CATEGORY_ID}` +
    `&limit=${Math.min(limit, 50)}` +
    `&fields=fsq_id,name,location`;

  const searchData = await httpGetFsq(searchUrl, key);

  if (searchData.message) {
    throw new Error(`Foursquare Places search failed: ${searchData.message}`);
  }

  const rawPlaces = Array.isArray(searchData.results) ? searchData.results : [];

  // Fetch details for each place in parallel batches
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < rawPlaces.length; i += CONCURRENCY) {
    const batch = rawPlaces.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      batch.map(async (place) => {
        const det = await fetchFoursquarePlaceDetails(place.fsq_id, key).catch(() => null);
        const address = [
          place.location?.address,
          place.location?.locality,
          place.location?.region,
        ]
          .filter(Boolean)
          .join(', ');
        return {
          name: place.name,
          address,
          hourBlocks: det?.hourBlocks || [],
          tipTexts: det?.tipTexts || [],
        };
      }),
    );
    results.push(...details);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Enrichment helper
// ---------------------------------------------------------------------------

/**
 * Enrich a list of Venue objects with hours sourced from Foursquare.
 *
 * Only updates venues that currently have no hourBlocks.  Matches venues to
 * Foursquare results by normalised name (case-insensitive, punctuation-stripped).
 * For venues with tips but no structured hours, tip texts are fed through
 * hoursParser to extract any embedded kitchen-closing times.
 *
 * @param {Venue[]} venues
 * @param {Array<{name,hourBlocks,tipTexts}>} fsqVenues
 * @returns {Venue[]}
 */
function enrichVenuesWithFoursquareData(venues, fsqVenues) {
  function normaliseName(n) {
    return (n || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  const fsqByName = new Map();
  for (const fsq of fsqVenues) {
    fsqByName.set(normaliseName(fsq.name), fsq);
  }

  return venues.map((venue) => {
    if (venue.hourBlocks && venue.hourBlocks.length > 0) return venue;

    const fsq = fsqByName.get(normaliseName(venue.name));
    if (!fsq) return venue;

    // Try structured hours first, then fall back to tip text parsing
    let hourBlocks = fsq.hourBlocks || [];
    let hoursSource = 'foursquare';

    if (hourBlocks.length === 0 && fsq.tipTexts && fsq.tipTexts.length > 0) {
      hourBlocks = parseHours(fsq.tipTexts.join('\n'));
      hoursSource = 'foursquare_tip';
    }

    const combinedText = fsq.tipTexts.join('\n');
    const is24Hours = detect24Hours(combinedText);

    if (hourBlocks.length === 0 && !is24Hours) return venue;
    const status = is24Hours
      ? { serving: true, opensAt: null, closesAt: null }
      : isCurrentlyServing(hourBlocks);

    return {
      ...venue,
      hourBlocks,
      is24Hours,
      serving: status.serving,
      opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
      closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
      hoursSource,
    };
  });
}

module.exports = {
  searchFoursquareVenues,
  parseFoursquareHoursToBlocks,
  enrichVenuesWithFoursquareData,
  fetchFoursquarePlaceDetails,
};
