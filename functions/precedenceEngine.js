'use strict';

/**
 * Precedence Logic Engine
 *
 * Resolves conflicting data from multiple scrape sources using a
 * proprietary quality hierarchy with time-decay weighting.
 *
 * Sources ranked by base trust:
 *   venue_claimed  → 1.00  (owner-verified, no decay; emergency closures are absolute)
 *   instagram_post → 0.85  (high intent if recent, fast decay)
 *   facebook_about → 0.75  (semi-structured, medium decay)
 *   google_structured → 0.60 (often wrong for kitchens, slow decay)
 *   osm_tags       → 0.50  (community-edited, slow decay)
 *   foursquare     → 0.30  (user tips, lowest weight)
 *   user_reported  → 0.40–0.90 (crowd-sourced yes/no, scales with volume + consensus)
 */

/** Base weights for sources (descending trust order) */
const SOURCE_WEIGHTS = {
  venue_claimed: 1.0,
  instagram_post: 0.85,
  facebook_about: 0.75,
  google_structured: 0.60,
  osm_tags: 0.50,
  foursquare: 0.30,
  user_reported: 0.40
};

/**
 * User-report aggregate weighting constants.
 *
 * A single report starts at BASE_WEIGHT and grows by VOTE_STEP per
 * additional vote, capped at MAX_WEIGHT.  The volume weight is then
 * multiplied by the consensus ratio (fraction of votes on the winning
 * side) to give a final aggregate score.
 *
 * Examples (unanimous yes):
 *   1  vote  → 0.40 × 1.0 = 0.40
 *   5  votes → 0.60 × 1.0 = 0.60
 *  10  votes → 0.85 × 1.0 = 0.85
 *  11+ votes → 0.90 × 1.0 = 0.90  (capped)
 */
const USER_REPORT_BASE_WEIGHT = 0.40;
const USER_REPORT_VOTE_STEP   = 0.05;
const USER_REPORT_MAX_WEIGHT  = 0.90;

/** Default source weight for unknown sources */
const DEFAULT_SOURCE_WEIGHT = 0.30;

/** Scoring constants for computeRawConfidence */
const CONFIDENCE_BASELINE = 0.5;
const BOOST_HAS_HOURS = 0.2;
const BOOST_NON_HINT = 0.1;
const BOOST_FOOD_SECTION = 0.1;
const PENALTY_CALL_FOR_HOURS = 0.3;
const PENALTY_24_HOURS = 0.05;

/** Minimum confidence threshold for verified data */
const CONFIDENCE_THRESHOLD = 0.30;

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
  if (src.includes('user_reported') || src.includes('user reported')) return 'user_reported';
  if (src.includes('claimed')) return 'venue_claimed';
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
 * Special case: a `venue_claimed` log whose `raw_scrape_payload`
 * contains `{ emergency_closure: true }` is an absolute override —
 * it wins unconditionally regardless of any other source.
 *
 * @param {Array<{source: string, kitchen_close_time: string, observed_at: Date, raw_confidence: number, raw_scrape_payload?: object}>} logs
 * @param {Date} [now] - Override "now" for testing
 * @returns {{log: object, score: number}|null}
 */
function determineWinningHours(logs, now) {
  if (!logs || logs.length === 0) return null;

  // Emergency closure from a verified business owner is an absolute override.
  // Return it immediately without scoring any other source.
  for (const log of logs) {
    if (log.source === 'venue_claimed') {
      const payload = log.raw_scrape_payload || {};
      if (payload.emergency_closure === true) {
        return { log, score: 1.0 };
      }
    }
  }

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

    // Venue-claimed data and user reports never decay
    if (log.source === 'venue_claimed' || log.source === 'user_reported') {
      timeDecayPenalty = 0;
    }

    const baseWeight = SOURCE_WEIGHTS[log.source] || DEFAULT_SOURCE_WEIGHT;
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
  let score = CONFIDENCE_BASELINE;

  // Boost for explicit hour data
  if (venue.hourBlocks && venue.hourBlocks.length > 0) {
    score += BOOST_HAS_HOURS;
  }

  // Boost for non-hint hours (explicit in source)
  if (venue.hourBlocks && venue.hourBlocks.some(b => !b.fromHint)) {
    score += BOOST_NON_HINT;
  }

  // Boost for food-section-specific hours
  if (venue.hourBlocks && venue.hourBlocks.some(b => b.inFoodSection)) {
    score += BOOST_FOOD_SECTION;
  }

  // Penalty for callForHours
  if (venue.callForHours) {
    score -= PENALTY_CALL_FOR_HOURS;
  }

  // Penalty if 24-hour flag set (often unreliable)
  if (venue.is24Hours) {
    score -= PENALTY_24_HOURS;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Aggregate crowd-sourced user reports into a single confidence signal.
 *
 * Each report is a simple yes/no: "Is this kitchen still taking orders?"
 * Volume and consensus together determine how much to trust the aggregate.
 *
 * The returned object is NOT a log entry — it is a blending signal used
 * by the search handler to adjust the scraped-data confidence score:
 *   - is_serving_consensus = true  → boost confidence toward aggregate score
 *   - is_serving_consensus = false → suppress confidence using aggregate score
 *
 * @param {Array<{is_serving: boolean, observed_at: Date}>} reports
 * @returns {{ score: number, is_serving_consensus: boolean, vote_count: number, yes_count: number }|null}
 */
function aggregateUserReports(reports) {
  if (!reports || reports.length === 0) return null;

  const totalVotes  = reports.length;
  const yesVotes    = reports.filter((r) => r.is_serving === true).length;
  const isServingConsensus = yesVotes >= totalVotes / 2;
  const agreeingVotes      = isServingConsensus ? yesVotes : (totalVotes - yesVotes);
  const consensusRatio     = agreeingVotes / totalVotes;

  // Volume weight: starts at BASE and grows by VOTE_STEP per extra vote, capped at MAX
  const volumeWeight = Math.min(
    USER_REPORT_MAX_WEIGHT,
    USER_REPORT_BASE_WEIGHT + (totalVotes - 1) * USER_REPORT_VOTE_STEP
  );

  const score = volumeWeight * consensusRatio;

  return { score, is_serving_consensus: isServingConsensus, vote_count: totalVotes, yes_count: yesVotes };
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
  return typeof score === 'number' && score >= CONFIDENCE_THRESHOLD;
}

/** Minimum confidence threshold */

module.exports = {
  SOURCE_WEIGHTS,
  DEFAULT_SOURCE_WEIGHT,
  CONFIDENCE_THRESHOLD,
  CONFIDENCE_BASELINE,
  USER_REPORT_BASE_WEIGHT,
  USER_REPORT_VOTE_STEP,
  USER_REPORT_MAX_WEIGHT,
  determineWinningHours,
  computeRawConfidence,
  isConfidenceVerified,
  mapHoursSourceToScrapeSource,
  differenceInDays,
  aggregateUserReports
};
