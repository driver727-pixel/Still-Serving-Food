'use strict';

/**
 * Precedence Logic Engine
 *
 * Resolves conflicting data from multiple scrape sources using a
 * proprietary quality hierarchy with time-decay weighting.
 *
 * Sources ranked by base trust:
 *   venue_claimed  → 1.00  (owner-verified, no decay)
 *   instagram_post → 0.85  (high intent if recent, fast decay)
 *   facebook_about → 0.75  (semi-structured, medium decay)
 *   google_structured → 0.60 (often wrong for kitchens, slow decay)
 *   osm_tags       → 0.50  (community-edited, slow decay)
 *   foursquare     → 0.30  (user tips, lowest weight)
 */

const SOURCE_WEIGHTS = {
  venue_claimed: 1.0,
  instagram_post: 0.85,
  facebook_about: 0.75,
  google_structured: 0.60,
  osm_tags: 0.50,
  foursquare: 0.30
};

/**
 * Compute days between two dates (floor).
 * @param {Date} a - Later date
 * @param {Date} b - Earlier date
 * @returns {number}
 */
function differenceInDays(a, b) {
  const msPerDay = 86400000;
  return Math.floor((a.getTime() - b.getTime()) / msPerDay);
}

/**
 * Map a hoursSource string from the pipeline to a scrape_source enum value.
 * @param {string} hoursSource
 * @returns {string}
 */
function mapHoursSourceToScrapeSource(hoursSource) {
  if (!hoursSource) return 'google_structured';
  const src = hoursSource.toLowerCase();
  if (src.includes('instagram')) return 'instagram_post';
  if (src.includes('facebook')) return 'facebook_about';
  if (src.includes('osm')) return 'osm_tags';
  if (src.includes('foursquare')) return 'foursquare';
  if (src.includes('user') || src.includes('claimed')) return 'venue_claimed';
  return 'google_structured';
}

/**
 * Determine the winning hours from a set of scrape log observations.
 *
 * Each log entry represents one source's claim about kitchen hours
 * for a particular venue + day_of_week. The algorithm applies
 * source trust weights and time-decay penalties to select the
 * most reliable observation.
 *
 * @param {Array<{source: string, kitchen_close_time: string, observed_at: Date, raw_confidence: number}>} logs
 * @param {Date} [now] - Override "now" for testing
 * @returns {{log: object, score: number}|null}
 */
function determineWinningHours(logs, now) {
  if (!logs || logs.length === 0) return null;

  const currentDate = now || new Date();
  let bestLog = null;
  let highestScore = -Infinity;

  for (const log of logs) {
    const observedAt = log.observed_at instanceof Date
      ? log.observed_at
      : new Date(log.observed_at);

    const daysOld = differenceInDays(currentDate, observedAt);
    let timeDecayPenalty = 0;

    // Social posts lose value quickly; structured data degrades slowly
    if (log.source === 'instagram_post' || log.source === 'facebook_about') {
      timeDecayPenalty = daysOld * 0.05; // 5% per day
    } else if (log.source === 'google_structured' || log.source === 'osm_tags') {
      timeDecayPenalty = daysOld * 0.01; // 1% per day
    } else if (log.source === 'foursquare') {
      timeDecayPenalty = daysOld * 0.02; // 2% per day
    }

    // Venue-claimed data never decays
    if (log.source === 'venue_claimed') {
      timeDecayPenalty = 0;
    }

    const baseWeight = SOURCE_WEIGHTS[log.source] || 0.30;
    const rawConfidence = typeof log.raw_confidence === 'number' ? log.raw_confidence : 0.5;
    const finalScore = (baseWeight * rawConfidence) - timeDecayPenalty;

    if (finalScore > highestScore) {
      highestScore = finalScore;
      bestLog = log;
    }
  }

  return bestLog ? { log: bestLog, score: Math.max(0, highestScore) } : null;
}

/**
 * Compute a raw confidence score for a venue based on its data quality.
 * This is used when ingesting scrape results into the ledger.
 *
 * @param {object} venue - Venue object from pipeline
 * @param {string} source - scrape_source value
 * @returns {number} Confidence between 0.0 and 1.0
 */
function computeRawConfidence(venue, source) {
  let score = 0.5; // baseline

  // Boost for explicit hour data
  if (venue.hourBlocks && venue.hourBlocks.length > 0) {
    score += 0.2;
  }

  // Boost for non-hint hours (explicit in source)
  if (venue.hourBlocks && venue.hourBlocks.some(b => !b.fromHint)) {
    score += 0.1;
  }

  // Boost for food-section-specific hours
  if (venue.hourBlocks && venue.hourBlocks.some(b => b.inFoodSection)) {
    score += 0.1;
  }

  // Penalty for callForHours
  if (venue.callForHours) {
    score -= 0.3;
  }

  // Penalty if 24-hour flag set (often unreliable)
  if (venue.is24Hours) {
    score -= 0.05;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Check if a confidence score meets the minimum threshold
 * for showing data without a warning.
 *
 * Per spec: scores below 0.30 should trigger
 * "Kitchen hours unverified. Call ahead." warning.
 *
 * @param {number} score
 * @returns {boolean}
 */
function isConfidenceVerified(score) {
  return typeof score === 'number' && score >= 0.30;
}

/** Minimum confidence threshold */
const CONFIDENCE_THRESHOLD = 0.30;

module.exports = {
  SOURCE_WEIGHTS,
  CONFIDENCE_THRESHOLD,
  determineWinningHours,
  computeRawConfidence,
  isConfidenceVerified,
  mapHoursSourceToScrapeSource,
  differenceInDays
};
