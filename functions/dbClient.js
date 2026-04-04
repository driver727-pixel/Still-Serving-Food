'use strict';

/**
 * Database Client (PostgreSQL)
 *
 * CQRS-pattern database layer:
 *   - Write path: scrapes → kitchen_hours_log (append-only ledger)
 *   - Read path: current_kitchen_hours (optimized cache table)
 *
 * The precedence engine runs after writes to update the cache.
 *
 * When DATABASE_URL is not set, falls back to in-memory store
 * (venueStore.js) for backwards compatibility.
 */

const { determineWinningHours, computeRawConfidence, mapHoursSourceToScrapeSource } = require('./precedenceEngine');

let pool = null;

/**
 * Initialize the database connection pool.
 * Only connects if DATABASE_URL is set.
 * @returns {boolean} Whether DB is available
 */
function initDb() {
  if (pool) return true;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return false;

  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: dbUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    });
    return true;
  } catch (_err) {
    pool = null;
    return false;
  }
}

/**
 * Check if the database is available.
 * @returns {boolean}
 */
function isDbAvailable() {
  return pool !== null;
}

/**
 * Upsert a venue into the venues table.
 * @param {object} venue - Venue data
 * @returns {Promise<string>} venue UUID
 */
async function upsertVenue(venue) {
  if (!pool) throw new Error('Database not initialized');

  const result = await pool.query(
    `INSERT INTO venues (name, address, city, state, lat, lng, category, place_id_google)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (place_id_google) DO UPDATE SET
       name = EXCLUDED.name,
       address = EXCLUDED.address
     RETURNING id`,
    [
      venue.name,
      venue.address || venue.description || '',
      venue.city || '',
      venue.state || '',
      venue.lat || 0,
      venue.lng || 0,
      venue.category || null,
      venue.placeId || venue.place_id_google || null
    ]
  );

  return result.rows[0].id;
}

/**
 * Append a scrape observation to the kitchen_hours_log ledger.
 * NEVER updates or deletes — append-only by design.
 *
 * @param {string} venueId - UUID of the venue
 * @param {object} venue - Venue data from pipeline
 * @param {string} source - scrape_source enum value
 * @returns {Promise<void>}
 */
async function appendScrapeLog(venueId, venue, source) {
  if (!pool) throw new Error('Database not initialized');

  const rawConfidence = computeRawConfidence(venue, source);
  const hourBlocks = venue.hourBlocks || [];

  // Insert one row per day_of_week
  for (const block of hourBlocks) {
    const openTime = minutesToTime(block.open);
    const closeTime = minutesToTime(block.close);

    await pool.query(
      `INSERT INTO kitchen_hours_log
       (venue_id, source, day_of_week, kitchen_open_time, kitchen_close_time,
        confidence_score, raw_scrape_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        venueId,
        source,
        block.day,
        openTime,
        closeTime,
        rawConfidence,
        JSON.stringify({ hourBlocks, hoursSource: venue.hoursSource, scrapedAt: venue.scrapedAt })
      ]
    );
  }
}

/**
 * Run the precedence algorithm for a venue and update current_kitchen_hours.
 *
 * @param {string} venueId - UUID of the venue
 * @returns {Promise<void>}
 */
async function updateCurrentHours(venueId) {
  if (!pool) throw new Error('Database not initialized');

  // Get all recent logs for this venue (last 30 days)
  const logsResult = await pool.query(
    `SELECT source, day_of_week, kitchen_open_time, kitchen_close_time,
            confidence_score AS raw_confidence, observed_at
     FROM kitchen_hours_log
     WHERE venue_id = $1
       AND observed_at > NOW() - INTERVAL '30 days'
     ORDER BY observed_at DESC`,
    [venueId]
  );

  // Group by day_of_week
  const byDay = {};
  for (const row of logsResult.rows) {
    const day = row.day_of_week;
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(row);
  }

  // Run precedence for each day
  for (const [day, logs] of Object.entries(byDay)) {
    const winner = determineWinningHours(logs);
    if (!winner) continue;

    await pool.query(
      `INSERT INTO current_kitchen_hours
       (venue_id, day_of_week, kitchen_open_time, kitchen_close_time,
        best_source, overall_confidence_score, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (venue_id, day_of_week) DO UPDATE SET
         kitchen_open_time = EXCLUDED.kitchen_open_time,
         kitchen_close_time = EXCLUDED.kitchen_close_time,
         best_source = EXCLUDED.best_source,
         overall_confidence_score = EXCLUDED.overall_confidence_score,
         last_verified_at = EXCLUDED.last_verified_at`,
      [
        venueId,
        parseInt(day, 10),
        winner.log.kitchen_open_time,
        winner.log.kitchen_close_time,
        winner.log.source,
        winner.score
      ]
    );
  }
}

/**
 * Ingest a venue from the pipeline: upsert venue → log scrape → update cache.
 * This is the main CQRS write path.
 *
 * @param {object} venue - Venue data from the hybrid pipeline
 * @returns {Promise<string>} venue UUID
 */
async function ingestVenue(venue) {
  const source = mapHoursSourceToScrapeSource(venue.hoursSource);
  const venueId = await upsertVenue(venue);
  await appendScrapeLog(venueId, venue, source);
  await updateCurrentHours(venueId);
  return venueId;
}

/**
 * Query venues currently serving food near a location.
 * This hits the read-optimized current_kitchen_hours table.
 *
 * @param {object} params
 * @param {number} params.lat - Latitude
 * @param {number} params.lng - Longitude
 * @param {number} [params.radiusMiles=5] - Search radius in miles
 * @param {number} [params.dayOfWeek] - Current day (0-6)
 * @param {string} [params.currentTime] - Current time as HH:MM
 * @param {number} [params.limit=20] - Max results
 * @returns {Promise<Array>}
 */
async function queryOpenVenues(params) {
  if (!pool) throw new Error('Database not initialized');

  const {
    lat, lng,
    radiusMiles = 5,
    dayOfWeek,
    currentTime,
    limit = 20
  } = params;

  // Approximate degree-based distance (1 degree latitude ≈ 69 miles)
  const MILES_PER_DEGREE = 69.0;
  const latRange = radiusMiles / MILES_PER_DEGREE;
  const lngRange = radiusMiles / (MILES_PER_DEGREE * Math.cos(lat * Math.PI / 180));

  const result = await pool.query(
    `SELECT v.id, v.name, v.address, v.city, v.state, v.lat, v.lng,
            v.category, v.place_id_google,
            c.kitchen_open_time, c.kitchen_close_time,
            c.best_source, c.overall_confidence_score, c.last_verified_at
     FROM venues v
     JOIN current_kitchen_hours c ON v.id = c.venue_id
     WHERE v.lat BETWEEN $1 AND $2
       AND v.lng BETWEEN $3 AND $4
       AND c.day_of_week = $5
       AND c.kitchen_open_time <= $6::time
       AND c.kitchen_close_time >= $6::time
     ORDER BY ABS(v.lat - $7) + ABS(v.lng - $8) ASC
     LIMIT $9`,
    [
      lat - latRange, lat + latRange,
      lng - lngRange, lng + lngRange,
      dayOfWeek,
      currentTime,
      lat, lng,
      limit
    ]
  );

  return result.rows;
}

/**
 * Convert minutes since midnight to TIME string (HH:MM).
 * @param {number} minutes
 * @returns {string}
 */
function minutesToTime(minutes) {
  if (typeof minutes !== 'number' || isNaN(minutes)) return '00:00';
  const clamped = Math.max(0, Math.min(1440, minutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Close the connection pool.
 * @returns {Promise<void>}
 */
async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDb,
  isDbAvailable,
  upsertVenue,
  appendScrapeLog,
  updateCurrentHours,
  ingestVenue,
  queryOpenVenues,
  minutesToTime,
  closeDb
};
