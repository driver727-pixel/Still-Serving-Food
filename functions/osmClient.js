'use strict';

/**
 * osmClient.js
 *
 * Optional enrichment source: OpenStreetMap via the Overpass API.
 *
 * Many food establishments in OSM are tagged with:
 *   `opening_hours`           – general business hours in OSM opening_hours format
 *   `kitchen:opening_hours`   – kitchen/food-service specific hours
 *
 * No API key is required.  The Nominatim geocoding service and Overpass API
 * are both free, but should be used sparingly:
 *   • Nominatim: max 1 request/second; requires an identifying User-Agent.
 *   • Overpass:  use lightweight queries and include a timeout.
 *
 * Usage:  searchOsmVenues({ location: 'Brooklyn, NY', radiusKm: 5, limit: 20 })
 *   Returns a list of OsmVenueResult objects that can be used to enrich
 *   venues that have no hours from other sources.
 */

const https = require('https');
const { parseHours, detect24Hours, isCurrentlyServing, formatTime } = require('./hoursParser');

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/**
 * Identifying User-Agent required by Nominatim's usage policy.
 * See https://operations.osmfoundation.org/policies/nominatim/
 */
const USER_AGENT = 'Letsnarf/1.0 (https://letsnarf.com)';

/** OSM amenity values that represent food/drink establishments. */
const OSM_FOOD_AMENITIES = 'restaurant|bar|cafe|pub|fast_food|biergarten|food_court|ice_cream';

/** Default search radius around the geocoded location centroid (kilometres). */
const DEFAULT_RADIUS_KM = 5;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Perform an HTTPS GET with optional headers and return the parsed JSON body.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<object>}
 */
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': USER_AGENT, ...headers },
    };
    https
      .get(options, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`OSM JSON parse error: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Perform an HTTPS POST with a URL-encoded body and return the parsed JSON.
 * Used to send Overpass QL queries (Content-Type: application/x-www-form-urlencoded).
 * @param {string} url
 * @param {string} queryBody  Overpass QL string
 * @returns {Promise<object>}
 */
function httpPostOverpass(url, queryBody) {
  return new Promise((resolve, reject) => {
    const encoded = `data=${encodeURIComponent(queryBody)}`;
    const bodyBuffer = Buffer.from(encoded, 'utf8');
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': bodyBuffer.length,
        'User-Agent': USER_AGENT,
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Overpass JSON parse error: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Geocoding — Nominatim
// ---------------------------------------------------------------------------

/**
 * Geocode a location string to {lat, lng} using the Nominatim API.
 *
 * @param {string} location  E.g. "Brooklyn, NY"
 * @returns {Promise<{lat: number, lng: number}>}
 */
async function geocodeLocation(location) {
  if (!location || !location.trim()) {
    throw new Error('A location string is required for OSM geocoding.');
  }

  const url =
    `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(location.trim())}` +
    `&format=json&limit=1&addressdetails=0`;

  const data = await httpGetJson(url);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Nominatim found no results for location: "${location}"`);
  }

  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ---------------------------------------------------------------------------
// Overpass query
// ---------------------------------------------------------------------------

/**
 * Compute an axis-aligned bounding box from a centre point and radius.
 * @param {number} lat     Centre latitude
 * @param {number} lng     Centre longitude
 * @param {number} radiusKm
 * @returns {{south,north,west,east}}
 */
function buildBbox(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.32;
  // Longitude degrees per km shrinks toward the poles
  const lngDelta = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lng - lngDelta,
    east: lng + lngDelta,
  };
}

/**
 * Query the Overpass API for food establishments within the bounding box.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} [radiusKm]
 * @returns {Promise<object>}  Raw Overpass JSON response
 */
async function queryOverpass(lat, lng, radiusKm = DEFAULT_RADIUS_KM) {
  const bb = buildBbox(lat, lng, radiusKm);
  const bbox = `${bb.south},${bb.west},${bb.north},${bb.east}`;

  // Request nodes, ways, and relations; include tags and centre coordinates
  const query =
    `[out:json][timeout:20];` +
    `(` +
    `node["amenity"~"^(${OSM_FOOD_AMENITIES})$"]["name"](${bbox});` +
    `way["amenity"~"^(${OSM_FOOD_AMENITIES})$"]["name"](${bbox});` +
    `);` +
    `out body center;`;

  return httpPostOverpass(OVERPASS_URL, query);
}

// ---------------------------------------------------------------------------
// OSM opening_hours format conversion
// ---------------------------------------------------------------------------

/**
 * Convert an OSM opening_hours string into a format that hoursParser can read.
 *
 * The OSM opening_hours spec (https://wiki.openstreetmap.org/wiki/Key:opening_hours)
 * uses two-letter abbreviated day names (Mo, Tu, We, Th, Fr, Sa, Su), 24-hour
 * times, and semicolons as rule separators.  This function normalises those
 * conventions into the three-letter abbreviations and newline separators that
 * hoursParser already handles.
 *
 * Examples:
 *   "Mo-Fr 11:00-22:00; Sa-Su 12:00-23:00"  →  "Mon-Fri 11:00-22:00\nSat-Sun 12:00-23:00"
 *   "24/7"  →  "24/7"
 *   "Mo-Th 10:00-21:00, Fr 10:00-23:00"  →  "Mon-Thu 10:00-21:00\nFri 10:00-23:00"
 *
 * @param {string} osmHours
 * @returns {string}
 */
function convertOsmOpeningHours(osmHours) {
  if (!osmHours || typeof osmHours !== 'string') return '';
  return osmHours
    .replace(/\bMo\b/g, 'Mon')
    .replace(/\bTu\b/g, 'Tue')
    .replace(/\bWe\b/g, 'Wed')
    .replace(/\bTh\b/g, 'Thu')
    .replace(/\bFr\b/g, 'Fri')
    .replace(/\bSa\b/g, 'Sat')
    .replace(/\bSu\b/g, 'Sun')
    // Semicolons and commas separate independent rule blocks — treat as newlines
    .replace(/[;,]/g, '\n');
}

// ---------------------------------------------------------------------------
// Element parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single OSM element (node or way) into a minimal venue descriptor.
 *
 * @param {object} element  Overpass element
 * @returns {{name:string, lat:number|null, lng:number|null, openingHoursText:string, kitchenHoursText:string}|null}
 */
function parseOsmElement(element) {
  const tags = element.tags || {};
  const name = tags.name;
  if (!name) return null;

  // Prefer explicit centre point (ways) over the element's own coordinates
  const lat = element.center?.lat ?? element.lat ?? null;
  const lng = element.center?.lon ?? element.lon ?? null;

  return {
    name,
    lat,
    lng,
    openingHoursText: tags.opening_hours || '',
    // OSM tag for kitchen-specific hours is `kitchen:opening_hours`
    kitchenHoursText: tags['kitchen:opening_hours'] || '',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search OpenStreetMap for food establishments near the given location.
 *
 * Each result includes the raw OSM opening_hours and kitchen:opening_hours
 * strings.  Use convertOsmOpeningHours() + hoursParser to extract HourBlocks.
 *
 * @param {object} params
 * @param {string} params.location         Location string, e.g. "Brooklyn, NY"
 * @param {number} [params.radiusKm=5]     Search radius around the geocoded centroid
 * @param {number} [params.limit=20]       Maximum number of results to return
 * @returns {Promise<Array<{name,lat,lng,openingHoursText,kitchenHoursText}>>}
 */
async function searchOsmVenues({ location, radiusKm = DEFAULT_RADIUS_KM, limit = 20 } = {}) {
  const { lat, lng } = await geocodeLocation(location);
  const raw = await queryOverpass(lat, lng, radiusKm);
  const elements = Array.isArray(raw.elements) ? raw.elements : [];

  const venues = [];
  for (const el of elements) {
    const venue = parseOsmElement(el);
    if (venue) venues.push(venue);
    if (venues.length >= limit) break;
  }

  return venues;
}

/**
 * Enrich a list of Venue objects with hours sourced from OpenStreetMap.
 *
 * Only updates venues that currently have no hourBlocks.  Matches venues to
 * OSM results by normalised name (case-insensitive, punctuation-stripped).
 *
 * @param {Venue[]} venues
 * @param {Array<{name,openingHoursText,kitchenHoursText}>} osmVenues
 * @param {Date} [now]  Reference time for open/closed determination.  Pass a
 *   timezone-adjusted Date to get accurate results when the server runs in a
 *   different timezone from the venues.
 * @returns {Venue[]}
 */
function enrichVenuesWithOsmData(venues, osmVenues, now = new Date()) {
  function normaliseName(n) {
    return (n || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Build a lookup map keyed by normalised name
  const osmByName = new Map();
  for (const osm of osmVenues) {
    osmByName.set(normaliseName(osm.name), osm);
  }

  return venues.map((venue) => {
    if (venue.hourBlocks && venue.hourBlocks.length > 0) return venue;

    const osm = osmByName.get(normaliseName(venue.name));
    if (!osm) return venue;

    // Prefer kitchen-specific hours; fall back to general opening hours
    const rawText = osm.kitchenHoursText || osm.openingHoursText;
    if (!rawText) return venue;

    const convertedText = convertOsmOpeningHours(rawText);
    const is24Hours = detect24Hours(convertedText);
    const hourBlocks = parseHours(convertedText);

    // Require either parsed hour blocks or a detected 24-hour signal
    if (hourBlocks.length === 0 && !is24Hours) return venue;

    const status = is24Hours
      ? { serving: true, opensAt: null, closesAt: null }
      : isCurrentlyServing(hourBlocks, now);

    return {
      ...venue,
      hourBlocks,
      is24Hours,
      serving: status.serving,
      opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
      closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
      hoursSource: osm.kitchenHoursText ? 'osm_kitchen' : 'osm',
    };
  });
}

module.exports = {
  searchOsmVenues,
  geocodeLocation,
  convertOsmOpeningHours,
  enrichVenuesWithOsmData,
  parseOsmElement,
  buildBbox,
};
