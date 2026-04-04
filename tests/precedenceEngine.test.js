'use strict';

const {
  SOURCE_WEIGHTS,
  CONFIDENCE_THRESHOLD,
  USER_REPORT_BASE_WEIGHT,
  USER_REPORT_VOTE_STEP,
  USER_REPORT_MAX_WEIGHT,
  determineWinningHours,
  computeRawConfidence,
  isConfidenceVerified,
  mapHoursSourceToScrapeSource,
  differenceInDays,
  aggregateUserReports,
} = require('../functions/precedenceEngine');

describe('precedenceEngine', () => {
  describe('SOURCE_WEIGHTS', () => {
    test('venue_claimed has highest weight', () => {
      expect(SOURCE_WEIGHTS.venue_claimed).toBe(1.0);
    });

    test('all sources have defined weights', () => {
      const sources = ['venue_claimed', 'instagram_post', 'facebook_about', 'google_structured', 'osm_tags', 'foursquare', 'user_reported'];
      for (const src of sources) {
        expect(SOURCE_WEIGHTS[src]).toBeDefined();
        expect(SOURCE_WEIGHTS[src]).toBeGreaterThan(0);
        expect(SOURCE_WEIGHTS[src]).toBeLessThanOrEqual(1);
      }
    });

    test('weights are in descending order of trust', () => {
      expect(SOURCE_WEIGHTS.venue_claimed).toBeGreaterThan(SOURCE_WEIGHTS.instagram_post);
      expect(SOURCE_WEIGHTS.instagram_post).toBeGreaterThan(SOURCE_WEIGHTS.facebook_about);
      expect(SOURCE_WEIGHTS.facebook_about).toBeGreaterThan(SOURCE_WEIGHTS.google_structured);
      expect(SOURCE_WEIGHTS.google_structured).toBeGreaterThan(SOURCE_WEIGHTS.osm_tags);
      expect(SOURCE_WEIGHTS.osm_tags).toBeGreaterThan(SOURCE_WEIGHTS.foursquare);
    });
  });

  describe('CONFIDENCE_THRESHOLD', () => {
    test('threshold is 0.30', () => {
      expect(CONFIDENCE_THRESHOLD).toBe(0.30);
    });
  });

  describe('differenceInDays', () => {
    test('returns 0 for same day', () => {
      const now = new Date('2026-04-04T12:00:00Z');
      expect(differenceInDays(now, now)).toBe(0);
    });

    test('returns correct days between dates', () => {
      const a = new Date('2026-04-10T12:00:00Z');
      const b = new Date('2026-04-04T12:00:00Z');
      expect(differenceInDays(a, b)).toBe(6);
    });

    test('floors partial days', () => {
      const a = new Date('2026-04-05T06:00:00Z');
      const b = new Date('2026-04-04T12:00:00Z');
      expect(differenceInDays(a, b)).toBe(0); // only 18 hours
    });
  });

  describe('determineWinningHours', () => {
    const now = new Date('2026-04-04T12:00:00Z');

    test('returns null for empty logs', () => {
      expect(determineWinningHours([])).toBeNull();
      expect(determineWinningHours(null)).toBeNull();
    });

    test('returns single log when only one present', () => {
      const logs = [{
        source: 'google_structured',
        kitchen_close_time: '22:00',
        observed_at: now,
        raw_confidence: 0.8,
      }];
      const result = determineWinningHours(logs, now);
      expect(result).not.toBeNull();
      expect(result.log).toBe(logs[0]);
      expect(result.score).toBeGreaterThan(0);
    });

    test('prefers venue_claimed over all other sources at equal confidence', () => {
      const logs = [
        { source: 'instagram_post', kitchen_close_time: '23:00', observed_at: now, raw_confidence: 0.8 },
        { source: 'venue_claimed', kitchen_close_time: '22:00', observed_at: now, raw_confidence: 0.8 },
        { source: 'facebook_about', kitchen_close_time: '21:00', observed_at: now, raw_confidence: 0.8 },
      ];
      const result = determineWinningHours(logs, now);
      expect(result.log.source).toBe('venue_claimed');
    });

    test('social posts decay faster than structured data', () => {
      const tenDaysAgo = new Date('2026-03-25T12:00:00Z');
      const logs = [
        { source: 'instagram_post', kitchen_close_time: '23:00', observed_at: tenDaysAgo, raw_confidence: 1.0 },
        { source: 'google_structured', kitchen_close_time: '22:00', observed_at: tenDaysAgo, raw_confidence: 0.8 },
      ];
      const result = determineWinningHours(logs, now);
      // Instagram decays at 5%/day (10 days = 0.50 penalty), Google at 1%/day (0.10 penalty)
      // Instagram: 0.85*1.0 - 0.50 = 0.35
      // Google:    0.60*0.8 - 0.10 = 0.38
      expect(result.log.source).toBe('google_structured');
    });

    test('venue_claimed never decays', () => {
      const oldDate = new Date('2025-01-01T00:00:00Z');
      const logs = [
        { source: 'venue_claimed', kitchen_close_time: '22:00', observed_at: oldDate, raw_confidence: 0.5 },
        { source: 'google_structured', kitchen_close_time: '21:00', observed_at: now, raw_confidence: 0.7 },
      ];
      const result = determineWinningHours(logs, now);
      // venue_claimed: 1.0*0.5 - 0 = 0.50
      // google: 0.60*0.7 - 0 = 0.42
      expect(result.log.source).toBe('venue_claimed');
    });

    test('recent instagram beats old google', () => {
      const logs = [
        { source: 'instagram_post', kitchen_close_time: '23:00', observed_at: now, raw_confidence: 0.9 },
        { source: 'google_structured', kitchen_close_time: '22:00', observed_at: now, raw_confidence: 0.7 },
      ];
      const result = determineWinningHours(logs, now);
      // Instagram: 0.85*0.9 = 0.765
      // Google:    0.60*0.7 = 0.42
      expect(result.log.source).toBe('instagram_post');
    });

    test('handles string dates in observed_at', () => {
      const logs = [{
        source: 'facebook_about',
        kitchen_close_time: '21:00',
        observed_at: '2026-04-04T12:00:00Z',
        raw_confidence: 0.7,
      }];
      const result = determineWinningHours(logs, now);
      expect(result).not.toBeNull();
      expect(result.log.source).toBe('facebook_about');
    });

    test('score never goes below 0', () => {
      const veryOldDate = new Date('2020-01-01T00:00:00Z');
      const logs = [{
        source: 'instagram_post',
        kitchen_close_time: '23:00',
        observed_at: veryOldDate,
        raw_confidence: 0.1,
      }];
      const result = determineWinningHours(logs, now);
      expect(result.score).toBe(0);
    });

    test('defaults raw_confidence to 0.5 when missing', () => {
      const logs = [{
        source: 'foursquare',
        kitchen_close_time: '20:00',
        observed_at: now,
      }];
      const result = determineWinningHours(logs, now);
      // foursquare: 0.30 * 0.5 = 0.15
      expect(result.score).toBeCloseTo(0.15, 2);
    });
    test('emergency closure venue_claimed wins unconditionally', () => {
      const now = new Date('2026-04-04T12:00:00Z');
      const logs = [
        { source: 'venue_claimed', kitchen_close_time: null, observed_at: now, raw_confidence: 1.0,
          raw_scrape_payload: { emergency_closure: true, reason: 'robbery' } },
        { source: 'instagram_post', kitchen_close_time: '23:00', observed_at: now, raw_confidence: 1.0 },
        { source: 'google_structured', kitchen_close_time: '22:00', observed_at: now, raw_confidence: 0.9 },
      ];
      const result = determineWinningHours(logs, now);
      expect(result.log.source).toBe('venue_claimed');
      expect(result.log.raw_scrape_payload.emergency_closure).toBe(true);
      expect(result.score).toBe(1.0);
    });

    test('non-emergency venue_claimed does not trigger absolute override', () => {
      const now = new Date('2026-04-04T12:00:00Z');
      const logs = [
        { source: 'venue_claimed', kitchen_close_time: '22:00', observed_at: now, raw_confidence: 0.6 },
        { source: 'instagram_post', kitchen_close_time: '23:00', observed_at: now, raw_confidence: 1.0 },
      ];
      const result = determineWinningHours(logs, now);
      // venue_claimed: 1.0*0.6 = 0.60; instagram: 0.85*1.0 = 0.85 → instagram wins
      expect(result.log.source).toBe('instagram_post');
    });
  });

  describe('aggregateUserReports', () => {
    test('returns null for empty or missing input', () => {
      expect(aggregateUserReports([])).toBeNull();
      expect(aggregateUserReports(null)).toBeNull();
      expect(aggregateUserReports(undefined)).toBeNull();
    });

    test('single yes vote returns base weight', () => {
      const result = aggregateUserReports([{ is_serving: true }]);
      expect(result).not.toBeNull();
      expect(result.score).toBeCloseTo(USER_REPORT_BASE_WEIGHT, 5);
      expect(result.is_serving_consensus).toBe(true);
      expect(result.vote_count).toBe(1);
      expect(result.yes_count).toBe(1);
    });

    test('single no vote returns base weight with no-consensus', () => {
      const result = aggregateUserReports([{ is_serving: false }]);
      expect(result.score).toBeCloseTo(USER_REPORT_BASE_WEIGHT, 5);
      expect(result.is_serving_consensus).toBe(false);
      expect(result.yes_count).toBe(0);
    });

    test('weight grows with more votes', () => {
      const fiveYes = Array(5).fill({ is_serving: true });
      const tenYes  = Array(10).fill({ is_serving: true });
      const r5  = aggregateUserReports(fiveYes);
      const r10 = aggregateUserReports(tenYes);
      // 5 votes: BASE + 4*STEP; 10 votes: BASE + 9*STEP (both unanimous → score = weight)
      expect(r5.score).toBeCloseTo(USER_REPORT_BASE_WEIGHT + 4 * USER_REPORT_VOTE_STEP, 5);
      expect(r10.score).toBeCloseTo(USER_REPORT_BASE_WEIGHT + 9 * USER_REPORT_VOTE_STEP, 5);
      expect(r10.score).toBeGreaterThan(r5.score);
    });

    test('weight caps at USER_REPORT_MAX_WEIGHT', () => {
      const manyYes = Array(100).fill({ is_serving: true });
      const result = aggregateUserReports(manyYes);
      expect(result.score).toBeCloseTo(USER_REPORT_MAX_WEIGHT, 5);
    });

    test('consensus ratio reduces score on split vote', () => {
      // 7 yes, 3 no → consensus = yes, ratio = 0.7
      const votes = [...Array(7).fill({ is_serving: true }), ...Array(3).fill({ is_serving: false })];
      const result = aggregateUserReports(votes);
      expect(result.is_serving_consensus).toBe(true);
      const expectedWeight = Math.min(USER_REPORT_MAX_WEIGHT, USER_REPORT_BASE_WEIGHT + 9 * USER_REPORT_VOTE_STEP);
      expect(result.score).toBeCloseTo(expectedWeight * 0.7, 5);
    });

    test('tie goes to yes consensus', () => {
      const votes = [{ is_serving: true }, { is_serving: false }];
      const result = aggregateUserReports(votes);
      // yesVotes (1) >= totalVotes/2 (1) → yes consensus
      expect(result.is_serving_consensus).toBe(true);
    });
  });
  describe('computeRawConfidence', () => {
    test('returns baseline 0.5 for empty venue', () => {
      const venue = {};
      expect(computeRawConfidence(venue, 'google_structured')).toBe(0.5);
    });

    test('boosts for hourBlocks', () => {
      const venue = { hourBlocks: [{ day: 1, open: 660, close: 1320 }] };
      expect(computeRawConfidence(venue, 'google_structured')).toBeGreaterThan(0.5);
    });

    test('boosts for non-hint hours', () => {
      const venue = { hourBlocks: [{ day: 1, open: 660, close: 1320, fromHint: false }] };
      const score = computeRawConfidence(venue, 'facebook_about');
      expect(score).toBeGreaterThanOrEqual(0.79); // 0.5 + 0.2 + 0.1 (float rounding)
      expect(score).toBeLessThanOrEqual(0.8);
    });

    test('boosts for food section hours', () => {
      const venue = { hourBlocks: [{ day: 1, open: 660, close: 1320, inFoodSection: true }] };
      expect(computeRawConfidence(venue, 'google_structured')).toBeGreaterThanOrEqual(0.8);
    });

    test('penalizes callForHours', () => {
      const venue = { callForHours: true };
      expect(computeRawConfidence(venue, 'google_structured')).toBe(0.2);
    });

    test('caps at 1.0', () => {
      const venue = {
        hourBlocks: [{ day: 1, open: 660, close: 1320, fromHint: false, inFoodSection: true }],
      };
      expect(computeRawConfidence(venue, 'google_structured')).toBeLessThanOrEqual(1.0);
    });

    test('floors at 0', () => {
      const venue = { callForHours: true, is24Hours: true };
      expect(computeRawConfidence(venue, 'google_structured')).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isConfidenceVerified', () => {
    test('returns true for scores >= 0.30', () => {
      expect(isConfidenceVerified(0.30)).toBe(true);
      expect(isConfidenceVerified(0.5)).toBe(true);
      expect(isConfidenceVerified(1.0)).toBe(true);
    });

    test('returns false for scores < 0.30', () => {
      expect(isConfidenceVerified(0.29)).toBe(false);
      expect(isConfidenceVerified(0)).toBe(false);
      expect(isConfidenceVerified(0.1)).toBe(false);
    });

    test('returns false for non-numeric input', () => {
      expect(isConfidenceVerified(null)).toBe(false);
      expect(isConfidenceVerified(undefined)).toBe(false);
      expect(isConfidenceVerified('0.5')).toBe(false);
    });
  });

  describe('mapHoursSourceToScrapeSource', () => {
    test('maps instagram sources', () => {
      expect(mapHoursSourceToScrapeSource('instagram_posts')).toBe('instagram_post');
      expect(mapHoursSourceToScrapeSource('Instagram Bio')).toBe('instagram_post');
    });

    test('maps facebook sources', () => {
      expect(mapHoursSourceToScrapeSource('facebook_about')).toBe('facebook_about');
      expect(mapHoursSourceToScrapeSource('facebook_posts')).toBe('facebook_about');
    });

    test('maps osm sources', () => {
      expect(mapHoursSourceToScrapeSource('osm_kitchen_hours')).toBe('osm_tags');
      expect(mapHoursSourceToScrapeSource('osm_opening_hours')).toBe('osm_tags');
    });

    test('maps foursquare sources', () => {
      expect(mapHoursSourceToScrapeSource('foursquare_hours')).toBe('foursquare');
    });

    test('maps user/claimed sources', () => {
      expect(mapHoursSourceToScrapeSource('user_reported')).toBe('user_reported');
      expect(mapHoursSourceToScrapeSource('user reported')).toBe('user_reported');
      expect(mapHoursSourceToScrapeSource('venue_claimed')).toBe('venue_claimed');
    });

    test('defaults to google_structured', () => {
      expect(mapHoursSourceToScrapeSource('unknown')).toBe('google_structured');
      expect(mapHoursSourceToScrapeSource(null)).toBe('google_structured');
      expect(mapHoursSourceToScrapeSource(undefined)).toBe('google_structured');
    });
  });
});
