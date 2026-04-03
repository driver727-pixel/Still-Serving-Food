'use strict';

/**
 * hybridPipeline.js
 *
 * Orchestrates the four-phase "Hybrid Discovery & Targeted Facebook Scraping"
 * pipeline for Letsnarf.com.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Phase 1 – Entity Verification                                           │
 * │   Google Places Text Search → clean list of restaurant/bar/cafe/food   │
 * │   entities in the target area. Eliminates Reddit threads, parking       │
 * │   garages, and other noise that broad web search returns.               │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 2 – Facebook URL Resolution                                       │
 * │   For each entity, inspect its `website` field:                         │
 * │     • Direct Facebook URL   → use as-is.                               │
 * │     • Standard website      → scrape homepage for social-footer links. │
 * │     • No website            → skip (venue returned without FB hours).   │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 3 – Targeted Facebook Extraction                                  │
 * │   Pass discovered Facebook page URLs to the Facebook scraper (Firecrawl │
 * │   or Apify). Extracts About section text (permanent hours) and the 3    │
 * │   most recent posts (real-time updates).                                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Phase 4 – Data Merging                                                  │
 * │   Merge Phase-1 entity data (canonical name, address, placeId) with     │
 * │   Phase-3 hour data. Tag each result with the hours source so the       │
 * │   frontend can display e.g. "Hours sourced from recent Facebook post".  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const { searchPlaces } = require('./placesClient');
const { resolveFacebookUrl } = require('./facebookResolver');
const { scrapeFacebookPage } = require('./facebookScraper');

/** Maximum number of concurrent Firecrawl scrape calls in Phase 2. */
const PHASE2_CONCURRENCY = 5;

/** Maximum number of concurrent Facebook scrape calls in Phase 3. */
const PHASE3_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Phase 4 helpers: Data Merging
// ---------------------------------------------------------------------------

/**
 * Build a minimal Venue object from a Google Places entity when no Facebook
 * hours data is available.
 *
 * @param {PlaceResult} place
 * @returns {Venue}
 */
function buildVenueFromPlace(place) {
  return {
    name: place.name,
    url: place.website || '',
    description: place.address || '',
    hourBlocks: [],
    is24Hours: false,
    serving: false,
    opensAt: null,
    closesAt: null,
    callForHours: false,
    hoursSource: null,
    facebookUrl: place.facebookUrl || null,
    placeId: place.placeId,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Merge a Google Places entity (Phase 1) with Facebook scraped data (Phase 3).
 *
 * Canonical entity identity (name, address, placeId) always comes from
 * Google Places. Hours and serving status come from Facebook when available.
 *
 * @param {PlaceResult & {facebookUrl: string|null}} place
 * @param {FacebookResult|null} fbData
 * @returns {Venue}
 */
function mergeVenue(place, fbData) {
  const base = buildVenueFromPlace(place);
  if (!fbData) return base;

  return {
    ...base,
    hourBlocks: fbData.hourBlocks || [],
    is24Hours: fbData.is24Hours || false,
    serving: fbData.serving || false,
    opensAt: fbData.opensAt || null,
    closesAt: fbData.closesAt || null,
    // Flag callForHours when the scraper hit a login wall so the UI can
    // prompt the user to check directly.
    callForHours: fbData.hitLoginWall === true,
    hoursSource: fbData.hoursSource || null,
    facebookUrl: fbData.facebookUrl || place.facebookUrl || null,
  };
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full hybrid pipeline for the given search parameters.
 *
 * @param {object} searchParams
 * @param {string} [searchParams.location]     Target area, e.g. "Brooklyn, NY"
 * @param {string} [searchParams.name]         Specific restaurant name (unused in Phase 1)
 * @param {string} [searchParams.servingUntil] Time hint, e.g. "10pm" (informational)
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {string} [options.firecrawlApiKey]   Overrides FIRECRAWL_API_KEY
 * @param {string} [options.googlePlacesApiKey] Overrides GOOGLE_PLACES_API_KEY
 * @param {string} [options.apifyApiKey]       Overrides APIFY_API_KEY
 * @returns {Promise<Venue[]>}
 */
async function runHybridPipeline(searchParams, options = {}) {
  const {
    limit = 10,
    firecrawlApiKey = process.env.FIRECRAWL_API_KEY,
    googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY,
    apifyApiKey = process.env.APIFY_API_KEY,
  } = options;

  // ── Phase 1: Entity Verification ─────────────────────────────────────────
  const places = await searchPlaces({
    location: searchParams.location || '',
    limit,
    apiKey: googlePlacesApiKey,
  });

  // ── Phase 2: Facebook URL Resolution ─────────────────────────────────────
  // Resolve in parallel batches to avoid overloading Firecrawl.
  const withFbUrls = [];
  for (let i = 0; i < places.length; i += PHASE2_CONCURRENCY) {
    const batch = places.slice(i, i + PHASE2_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (place) => {
        const facebookUrl = await resolveFacebookUrl(place, firecrawlApiKey).catch(() => null);
        return { ...place, facebookUrl };
      }),
    );
    withFbUrls.push(...resolved);
  }

  // ── Phase 3: Targeted Facebook Extraction ────────────────────────────────
  // Only scrape places that have a resolved Facebook URL.
  const fbPlaces = withFbUrls.filter((p) => p.facebookUrl);
  const nonFbPlaces = withFbUrls.filter((p) => !p.facebookUrl);

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

  // ── Phase 4: Data Merging ─────────────────────────────────────────────────
  const venues = [
    ...fbPlaces.map((place) => mergeVenue(place, fbResults.get(place.facebookUrl) ?? null)),
    ...nonFbPlaces.map((place) => buildVenueFromPlace(place)),
  ];

  return venues;
}

module.exports = { runHybridPipeline, mergeVenue, buildVenueFromPlace };
