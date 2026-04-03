'use strict';

/**
 * hybridPipeline.js
 *
 * Orchestrates the multi-phase "Hybrid Discovery & Targeted Social Scraping"
 * pipeline for Letsnarf.com.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Phase 1 – Entity Verification                                           │
 * │   Google Places Text Search → clean list of restaurant/bar/cafe/food   │
 * │   entities in the target area. Also fetches Legacy opening_hours and,  │
 * │   when available, Places API (New) kitchen secondary hours.            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 2 – Social URL Resolution                                         │
 * │   For each entity, inspect its `website` field:                         │
 * │     • Direct Facebook URL   → use as-is.                               │
 * │     • Direct Instagram URL  → use as-is.                               │
 * │     • Standard website      → scrape homepage for social-footer links. │
 * │     • No website            → skip (venue returned without social hrs). │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 3a – Targeted Facebook Extraction                                 │
 * │   Pass discovered Facebook page URLs to the Facebook scraper (Firecrawl │
 * │   or Apify). Extracts About section text (permanent hours) and the 3    │
 * │   most recent posts (real-time updates).                                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 3b – Instagram Post Extraction (optional, requires APIFY_API_KEY) │
 * │   For venues without Facebook hours, scrape Instagram recent posts for  │
 * │   food/kitchen hour announcements via Apify.                            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 4 – Data Merging                                                  │
 * │   Merge Phase-1 entity data with Phase-3 hour data. When no social     │
 * │   hours are available, fall back to Google Places kitchen hours, then   │
 * │   to regular Google Places opening hours.                               │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 5 – OSM Enrichment (optional, free — no key required)            │
 * │   For venues still lacking hours, query OpenStreetMap via the Overpass  │
 * │   API and match by venue name. Uses kitchen:opening_hours tag first.    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 6 – Foursquare Enrichment (optional, requires FOURSQUARE_API_KEY) │
 * │   For venues still lacking hours, query Foursquare Places API v3 and   │
 * │   match by venue name. Also parses user tips for kitchen-close hints.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const { searchPlaces } = require('./placesClient');
const { resolveFacebookUrl, resolveInstagramUrl } = require('./facebookResolver');
const { scrapeFacebookPage } = require('./facebookScraper');
const { scrapeInstagramPage } = require('./instagramScraper');
const { searchOsmVenues, enrichVenuesWithOsmData } = require('./osmClient');
const { searchFoursquareVenues, enrichVenuesWithFoursquareData } = require('./foursquareClient');
const { isCurrentlyServing, formatTime, detect24Hours } = require('./hoursParser');

/** Maximum number of concurrent Firecrawl scrape calls in Phase 2. */
const PHASE2_CONCURRENCY = 5;

/** Maximum number of concurrent Facebook scrape calls in Phase 3a. */
const PHASE3_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Phase 4 helpers: Data Merging
// ---------------------------------------------------------------------------

/**
 * Build a minimal Venue object from a Google Places entity when no social-media
 * hours data is available.
 *
 * Preference order for hours:
 *   1. Google Places kitchen secondary hours (most specific, via Places API New)
 *   2. Google Places regular opening hours (Legacy Place Details)
 *   3. No hours (hourBlocks=[])
 *
 * @param {PlaceResult} place
 * @returns {Venue}
 */
function buildVenueFromPlace(place) {
  // Prefer kitchen-specific hours, then fall back to general opening hours
  const hourBlocks = place.kitchenHours || place.openingHours || [];
  const hoursSource =
    place.kitchenHours ? 'google_kitchen_hours'
    : place.openingHours ? 'google_opening_hours'
    : null;

  const is24Hours = detect24Hours(hourBlocks.map((b) => b.label || '').join(' '));
  const status =
    hourBlocks.length === 0
      ? { serving: false, opensAt: null, closesAt: null }
      : isCurrentlyServing(hourBlocks);

  return {
    name: place.name,
    url: place.website || '',
    description: place.address || '',
    hourBlocks,
    is24Hours,
    serving: status.serving,
    opensAt: status.opensAt != null ? formatTime(status.opensAt) : null,
    closesAt: status.closesAt != null ? formatTime(status.closesAt) : null,
    callForHours: false,
    hoursSource,
    facebookUrl: place.facebookUrl || null,
    placeId: place.placeId,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Merge a Google Places entity (Phase 1) with Facebook scraped data (Phase 3a)
 * and optionally Instagram data (Phase 3b).
 *
 * Priority for hours data:
 *   1. Facebook hours  (most trusted social source; explicit place hours)
 *   2. Instagram hours (real-time post signals)
 *   3. Google Places kitchen hours (structured, kitchen-specific)
 *   4. Google Places opening hours  (structured, general)
 *
 * Canonical entity identity (name, address, placeId) always comes from
 * Google Places.
 *
 * @param {PlaceResult & {facebookUrl: string|null, instagramUrl: string|null}} place
 * @param {FacebookResult|null} fbData
 * @param {InstagramResult|null} [igData]
 * @returns {Venue}
 */
function mergeVenue(place, fbData, igData) {
  const base = buildVenueFromPlace(place);

  // --- Facebook hours (highest social priority) ---
  if (fbData && (fbData.hourBlocks.length > 0 || fbData.is24Hours)) {
    return {
      ...base,
      hourBlocks: fbData.hourBlocks || [],
      is24Hours: fbData.is24Hours || false,
      serving: fbData.serving || false,
      opensAt: fbData.opensAt || null,
      closesAt: fbData.closesAt || null,
      callForHours: fbData.hitLoginWall === true,
      hoursSource: fbData.hoursSource || null,
      facebookUrl: fbData.facebookUrl || place.facebookUrl || null,
    };
  }

  // --- Instagram hours (real-time post signal) ---
  if (igData && (igData.hourBlocks.length > 0 || igData.is24Hours)) {
    return {
      ...base,
      hourBlocks: igData.hourBlocks || [],
      is24Hours: igData.is24Hours || false,
      serving: igData.serving || false,
      opensAt: igData.opensAt || null,
      closesAt: igData.closesAt || null,
      hoursSource: igData.hoursSource || null,
      facebookUrl: fbData?.facebookUrl || place.facebookUrl || null,
      // Carry the login-wall callForHours flag from FB if applicable
      callForHours: fbData?.hitLoginWall === true,
    };
  }

  // --- Google Places hours fallback ---
  // base already contains kitchenHours or openingHours if available.
  // Only update callForHours to reflect a FB login wall even when
  // we're falling back to Google hours.
  if (fbData) {
    return { ...base, callForHours: fbData.hitLoginWall === true };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full hybrid pipeline for the given search parameters.
 *
 * @param {object} searchParams
 * @param {string} [searchParams.location]      Target area, e.g. "Brooklyn, NY"
 * @param {string} [searchParams.name]          Specific restaurant name (unused in Phase 1)
 * @param {string} [searchParams.servingUntil]  Time hint, e.g. "10pm" (informational)
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {string} [options.firecrawlApiKey]    Overrides FIRECRAWL_API_KEY
 * @param {string} [options.googlePlacesApiKey] Overrides GOOGLE_PLACES_API_KEY
 * @param {string} [options.apifyApiKey]        Overrides APIFY_API_KEY
 * @param {string} [options.foursquareApiKey]   Overrides FOURSQUARE_API_KEY
 * @returns {Promise<Venue[]>}
 */
async function runHybridPipeline(searchParams, options = {}) {
  const {
    limit = 10,
    firecrawlApiKey = process.env.FIRECRAWL_API_KEY,
    googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY,
    apifyApiKey = process.env.APIFY_API_KEY,
    foursquareApiKey = process.env.FOURSQUARE_API_KEY,
  } = options;

  // ── Phase 1: Entity Verification ─────────────────────────────────────────
  // Returns PlaceResult objects now including openingHours and kitchenHours.
  const places = await searchPlaces({
    location: searchParams.location || '',
    limit,
    apiKey: googlePlacesApiKey,
  });

  // ── Phase 2: Social URL Resolution ───────────────────────────────────────
  // Resolve Facebook and Instagram URLs in parallel batches.
  const withSocialUrls = [];
  for (let i = 0; i < places.length; i += PHASE2_CONCURRENCY) {
    const batch = places.slice(i, i + PHASE2_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (place) => {
        const [facebookUrl, instagramUrl] = await Promise.all([
          resolveFacebookUrl(place, firecrawlApiKey).catch(() => null),
          resolveInstagramUrl(place, firecrawlApiKey).catch(() => null),
        ]);
        return { ...place, facebookUrl, instagramUrl };
      }),
    );
    withSocialUrls.push(...resolved);
  }

  // ── Phase 3a: Targeted Facebook Extraction ───────────────────────────────
  const fbPlaces = withSocialUrls.filter((p) => p.facebookUrl);
  const nonFbPlaces = withSocialUrls.filter((p) => !p.facebookUrl);

  const fbResults = new Map(); // facebookUrl -> FacebookResult
  for (let i = 0; i < fbPlaces.length; i += PHASE3_CONCURRENCY) {
    const batch = fbPlaces.slice(i, i + PHASE3_CONCURRENCY);
    const scraped = await Promise.all(
      batch.map(async (place) => {
        const result = await scrapeFacebookPage(place.facebookUrl, {
          firecrawlApiKey,
          apifyApiKey,
        }).catch(() => null);
        return { facebookUrl: place.facebookUrl, result };
      }),
    );
    for (const { facebookUrl, result } of scraped) {
      fbResults.set(facebookUrl, result);
    }
  }

  // ── Phase 3b: Instagram Post Extraction ──────────────────────────────────
  // Only run for venues where Facebook scraping returned no hours and an
  // Instagram URL was found.  Requires APIFY_API_KEY.
  const igResults = new Map(); // instagramUrl -> InstagramResult
  if (apifyApiKey) {
    const igCandidates = withSocialUrls.filter((p) => {
      if (!p.instagramUrl) return false;
      const fbData = fbResults.get(p.facebookUrl);
      // Skip if Facebook already returned usable hours
      if (fbData && (fbData.hourBlocks.length > 0 || fbData.is24Hours)) return false;
      return true;
    });

    for (let i = 0; i < igCandidates.length; i += PHASE3_CONCURRENCY) {
      const batch = igCandidates.slice(i, i + PHASE3_CONCURRENCY);
      const scraped = await Promise.all(
        batch.map(async (place) => {
          const result = await scrapeInstagramPage(place.instagramUrl, {
            apifyApiKey,
          }).catch(() => null);
          return { instagramUrl: place.instagramUrl, result };
        }),
      );
      for (const { instagramUrl, result } of scraped) {
        if (result) igResults.set(instagramUrl, result);
      }
    }
  }

  // ── Phase 4: Data Merging ─────────────────────────────────────────────────
  let venues = [
    ...fbPlaces.map((place) =>
      mergeVenue(
        place,
        fbResults.get(place.facebookUrl) ?? null,
        place.instagramUrl ? (igResults.get(place.instagramUrl) ?? null) : null,
      ),
    ),
    ...nonFbPlaces.map((place) =>
      mergeVenue(
        place,
        null,
        place.instagramUrl ? (igResults.get(place.instagramUrl) ?? null) : null,
      ),
    ),
  ];

  // ── Phase 5: OSM Enrichment ───────────────────────────────────────────────
  // Enrich venues that still have no hours using OpenStreetMap data.
  // Runs only when a location is provided; failures are silently swallowed so
  // they never break the overall pipeline.
  if (searchParams.location) {
    try {
      const osmVenues = await searchOsmVenues({
        location: searchParams.location,
        limit: Math.max(limit * 2, 40),
      });
      venues = enrichVenuesWithOsmData(venues, osmVenues);
    } catch {
      // OSM is an optional enrichment; continue without it
    }
  }

  // ── Phase 6: Foursquare Enrichment ───────────────────────────────────────
  // Enrich remaining no-hours venues using Foursquare Places API.
  if (foursquareApiKey && searchParams.location) {
    try {
      const fsqVenues = await searchFoursquareVenues({
        location: searchParams.location,
        limit: Math.max(limit * 2, 40),
        apiKey: foursquareApiKey,
      });
      venues = enrichVenuesWithFoursquareData(venues, fsqVenues);
    } catch {
      // Foursquare is an optional enrichment; continue without it
    }
  }

  return venues;
}

module.exports = { runHybridPipeline, mergeVenue, buildVenueFromPlace };
