'use strict';

/**
 * venueStore.js
 *
 * A lightweight in-memory cache for scraped venue data, keyed by location.
 * Results are considered fresh for CACHE_TTL_MS milliseconds.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const store = new Map(); // location -> { venues, fetchedAt }

/**
 * Return cached venues for a location, or null if cache is stale / missing.
 * @param {string} location
 * @returns {Venue[]|null}
 */
function get(location) {
  const key = normalise(location);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.venues;
}

/**
 * Store venues for a location.
 * @param {string} location
 * @param {Venue[]} venues
 */
function set(location, venues) {
  store.set(normalise(location), { venues, fetchedAt: Date.now() });
}

/**
 * Remove all cached entries.
 */
function clear() {
  store.clear();
}

function normalise(location) {
  return location.toLowerCase().replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { get, set, clear, normalise };
