'use strict';

/**
 * placesClient.js
 *
 * Phase 1 of the hybrid pipeline: Entity Verification.
 *
 * Wraps the Google Places API (Legacy) to:
 *   1. Search for food/beverage businesses in a target area (Text Search).
 *   2. Retrieve per-place website, address, and co-ordinates via Place Details.
 *
 * Only businesses whose Google Places `types` include at least one of
 * restaurant, bar, cafe, or food are returned, ensuring a clean entity list
 * free from parking garages, news articles, and other noise.
 */

const https = require('https');

const PLACES_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PLACES_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
/** Places API (New) base URL for secondary hours (kitchen type). */
const PLACES_NEW_DETAILS_URL = 'https://places.googleapis.com/v1/places';

/** Google Places types considered food/drink establishments. */
const FOOD_TYPES = new Set(['restaurant', 'bar', 'cafe', 'food', 'meal_takeaway', 'meal_delivery', 'bakery']);

/**
 * Perform an HTTPS GET and return the parsed JSON body.
 * @param {string} url
 * @param {object} [headers]  Optional HTTP headers
 * @returns {Promise<object>}
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers,
    };
    https
      .get(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Places API JSON parse error: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Parse Legacy Places API `opening_hours.periods` into HourBlocks.
 * Each period has `open` and `close` objects with `day` (0=Sun–6=Sat) and
 * `time` ("HHMM" 24-hour string).
 *
 * @param {Array} periods
 * @returns {Array<{day,open,close,label,inFoodSection}>}
 */
function parseOpeningPeriods(periods) {
  if (!Array.isArray(periods)) return [];
  const DAY_LABELS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const blocks = [];
  for (const period of periods) {
    const openDay = period.open?.day;
    const openTime = period.open?.time; // "HHMM"
    const closeTime = period.close?.time;
    if (openDay == null || !openTime || !closeTime) continue;
    const open = parseInt(openTime.slice(0, 2), 10) * 60 + parseInt(openTime.slice(2), 10);
    const close = parseInt(closeTime.slice(0, 2), 10) * 60 + parseInt(closeTime.slice(2), 10);
    blocks.push({ day: openDay, open, close, label: DAY_LABELS[openDay], inFoodSection: false });
  }
  return blocks;
}

/**
 * Parse Places API (New) secondary-hours periods into HourBlocks.
 * Periods have `open`/`close` objects with `day` (0=Sun–6=Sat), `hour`, and
 * optional `minute`.  These are kitchen-specific hours so `inFoodSection` is
 * set to true.
 *
 * @param {Array} periods
 * @returns {Array<{day,open,close,label,inFoodSection}>}
 */
function parseNewApiPeriods(periods) {
  if (!Array.isArray(periods)) return [];
  const DAY_LABELS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const blocks = [];
  for (const period of periods) {
    const openDay = period.open?.day;
    const openHour = period.open?.hour;
    const openMin = period.open?.minute ?? 0;
    const closeHour = period.close?.hour;
    const closeMin = period.close?.minute ?? 0;
    if (openDay == null || openHour == null || closeHour == null) continue;
    const open = openHour * 60 + openMin;
    const close = closeHour * 60 + closeMin;
    blocks.push({ day: openDay, open, close, label: DAY_LABELS[openDay], inFoodSection: true });
  }
  return blocks;
}

/**
 * Attempt to fetch kitchen-specific secondary hours from the Places API (New).
 *
 * This call is optional: if the API key does not have access to the New Places
 * API tier, or if the venue has no kitchen secondary hours, null is returned
 * and the caller falls back to regular opening hours.
 *
 * @param {string} placeId
 * @param {string} apiKey
 * @returns {Promise<Array<{day,open,close,label,inFoodSection}>|null>}
 */
async function fetchSecondaryHours(placeId, apiKey) {
  const url =
    `${PLACES_NEW_DETAILS_URL}/${encodeURIComponent(placeId)}` +
    `?key=${encodeURIComponent(apiKey)}`;
  try {
    const data = await httpGet(url, {
      'X-Goog-FieldMask': 'regularSecondaryOpeningHours',
    });
    if (data.error) return null;
    const secondary = Array.isArray(data.regularSecondaryOpeningHours)
      ? data.regularSecondaryOpeningHours
      : [];
    const kitchen = secondary.find((h) => h.secondaryHoursType === 'KITCHEN');
    if (!kitchen) return null;
    const blocks = parseNewApiPeriods(kitchen.periods || []);
    return blocks.length > 0 ? blocks : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Place Details for a single text-search result and return a
 * normalised PlaceResult, or null if the request fails.
 *
 * @param {string} placeId
 * @param {string} apiKey
 * @returns {Promise<PlaceResult|null>}
 */
async function fetchPlaceDetails(placeId, apiKey) {
  const fields = 'place_id,name,formatted_address,website,geometry,types,opening_hours';
  const url =
    `${PLACES_DETAILS_URL}?place_id=${encodeURIComponent(placeId)}` +
    `&fields=${fields}&key=${encodeURIComponent(apiKey)}`;

  try {
    const data = await httpGet(url);
    if (data.status !== 'OK') return null;

    const r = data.result;

    // Parse regular opening hours from Legacy API periods
    const openingHours = parseOpeningPeriods(r.opening_hours?.periods || []);

    // Attempt kitchen-specific secondary hours via Places API (New)
    const kitchenHours = await fetchSecondaryHours(placeId, apiKey);

    return {
      placeId: r.place_id,
      name: r.name,
      address: r.formatted_address,
      website: r.website || null,
      lat: r.geometry?.location?.lat ?? null,
      lng: r.geometry?.location?.lng ?? null,
      types: r.types || [],
      openingHours: openingHours.length > 0 ? openingHours : null,
      kitchenHours,
    };
  } catch {
    return null;
  }
}

/**
 * Return true when the place types array contains at least one food/drink type.
 * @param {string[]} types
 * @returns {boolean}
 */
function isFoodEstablishment(types) {
  return (types || []).some((t) => FOOD_TYPES.has(t));
}

/**
 * Search Google Places for food/beverage businesses in the given location.
 *
 * @param {object} params
 * @param {string} params.location   Location string, e.g. "Brooklyn, NY"
 * @param {number} [params.limit=20] Maximum number of places to return (≤ 20 per API page)
 * @param {string} [params.apiKey]   Overrides the GOOGLE_PLACES_API_KEY env var
 * @returns {Promise<PlaceResult[]>}
 */
async function searchPlaces({ location, limit = 20, apiKey } = {}) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set.');
  }

  if (!location || !location.trim()) {
    throw new Error('A location string is required for Google Places search.');
  }

  const query = `restaurants bars cafes food in ${location.trim()}`;
  const url =
    `${PLACES_TEXT_SEARCH_URL}?query=${encodeURIComponent(query)}` +
    `&type=restaurant&key=${encodeURIComponent(key)}`;

  const data = await httpGet(url);

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(
      `Google Places Text Search failed: ${data.status}` +
        (data.error_message ? ` – ${data.error_message}` : ''),
    );
  }

  const rawResults = (data.results || [])
    .filter((r) => isFoodEstablishment(r.types))
    .slice(0, limit);

  // Fetch website + co-ordinates for each place via Place Details (parallel)
  const CONCURRENCY = 5;
  const places = [];
  for (let i = 0; i < rawResults.length; i += CONCURRENCY) {
    const batch = rawResults.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map((r) => fetchPlaceDetails(r.place_id, key)));
    places.push(...details.filter(Boolean));
  }

  return places;
}

module.exports = { searchPlaces, isFoodEstablishment, parseOpeningPeriods, parseNewApiPeriods };
