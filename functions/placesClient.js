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

/** Google Places types considered food/drink establishments. */
const FOOD_TYPES = new Set(['restaurant', 'bar', 'cafe', 'food', 'meal_takeaway', 'meal_delivery', 'bakery']);

/**
 * Perform an HTTPS GET and return the parsed JSON body.
 * @param {string} url
 * @returns {Promise<object>}
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
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
 * Fetch Place Details for a single text-search result and return a
 * normalised PlaceResult, or null if the request fails.
 *
 * @param {string} placeId
 * @param {string} apiKey
 * @returns {Promise<PlaceResult|null>}
 */
async function fetchPlaceDetails(placeId, apiKey) {
  const fields = 'place_id,name,formatted_address,website,geometry,types';
  const url =
    `${PLACES_DETAILS_URL}?place_id=${encodeURIComponent(placeId)}` +
    `&fields=${fields}&key=${encodeURIComponent(apiKey)}`;

  try {
    const data = await httpGet(url);
    if (data.status !== 'OK') return null;

    const r = data.result;
    return {
      placeId: r.place_id,
      name: r.name,
      address: r.formatted_address,
      website: r.website || null,
      lat: r.geometry?.location?.lat ?? null,
      lng: r.geometry?.location?.lng ?? null,
      types: r.types || [],
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

module.exports = { searchPlaces, isFoodEstablishment };
