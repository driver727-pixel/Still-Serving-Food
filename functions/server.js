'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { searchVenues, scrapeVenue } = require('./scraper');
const { runHybridPipeline } = require('./hybridPipeline');
const venueStore = require('./venueStore');
const { generateAffiliateLinks } = require('./affiliateLinks');
const {
  isConfidenceVerified,
  computeRawConfidence,
  mapHoursSourceToScrapeSource,
  SOURCE_WEIGHTS,
  DEFAULT_SOURCE_WEIGHT,
  CONFIDENCE_THRESHOLD,
  aggregateUserReports,
} = require('./precedenceEngine');
const dbClient = require('./dbClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS — allow the static frontend hosted on letsnarf.com + Capacitor origins
const ALLOWED_ORIGINS = new Set([
  'https://letsnarf.com',
  'https://www.letsnarf.com',
  'capacitor://localhost',
  'http://localhost'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Security & SEO-friendly HTTP headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Allow Google AdSense scripts alongside the site's own scripts
      "script-src 'self' https://pagead2.googlesyndication.com https://partner.googleadservices.com",
      // AdSense injects inline styles; 'unsafe-inline' is required for it to render correctly
      "style-src 'self' 'unsafe-inline'",
      // Allow ad-creative images from Google's CDNs
      "img-src 'self' data: https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com",
      // Allow AdSense to phone home for ad delivery and measurement
      "connect-src 'self' https://pagead2.googlesyndication.com https://tpc.googlesyndication.com https://adservice.google.com",
      // AdSense renders creatives inside sandboxed iframes on these origins
      "frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

/**
 * Per-IP search counter for ad-gate monetisation.
 * After FREE_SEARCHES_PER_IP searches, the client must present a valid
 * ad token obtained from GET /api/ad-token.
 *
 * Map: ip -> { count, resetAt }
 */
const FREE_SEARCHES_PER_IP = 1;
const AD_TOKEN_TTL_MS = 5 * 60 * 1000; // tokens valid for 5 minutes
const searchCounters = new Map();
const adTokens = new Map(); // token -> expiresAt

function getSearchCount(ip) {
  const entry = searchCounters.get(ip);
  if (!entry) return 0;
  // Reset counter daily
  if (Date.now() > entry.resetAt) {
    searchCounters.delete(ip);
    return 0;
  }
  return entry.count;
}

function incrementSearchCount(ip) {
  const count = getSearchCount(ip);
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  searchCounters.set(ip, { count: count + 1, resetAt: Date.now() + MS_PER_DAY });
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// User-report crowd-sourcing
// ---------------------------------------------------------------------------

/**
 * In-memory store for crowd-sourced kitchen-status reports.
 * Key: normalised venue key (name + url).
 * Value: array of { is_serving: bool, observed_at: Date }
 *
 * Reports accumulate for the lifetime of the process. In a future iteration
 * a sliding time-window (e.g. last 24 hours) should be applied to prevent
 * stale crowd data from permanently skewing results. For now the volume of
 * reports is low enough that unbounded growth is not a practical concern.
 */
const userReportStore = new Map();

/**
 * Rate-limit guard: one report per IP+venue combination per 5 minutes.
 * Key: `${ip}:${venueKey}`, value: timestamp of last report.
 */
const userReportRateLimit = new Map();
const USER_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Rate-limit guard for business management endpoints.
 * Limits write operations (hours updates, emergency closures) to
 * one per IP per 60 seconds to prevent abuse of authenticated routes.
 * Key: `${ip}:${path}`, value: timestamp of last request.
 */
const businessActionRateLimit = new Map();
const BUSINESS_ACTION_COOLDOWN_MS = 60 * 1000;

/**
 * Check and record a business action rate-limit hit.
 * Returns true if the request is within the cooldown window (should be blocked).
 * @param {string} ip
 * @param {string} path
 * @returns {boolean}
 */
function isBusinessActionRateLimited(ip, path) {
  const key    = `${ip}:${path}`;
  const lastAt = businessActionRateLimit.get(key);
  if (lastAt && Date.now() - lastAt < BUSINESS_ACTION_COOLDOWN_MS) return true;
  businessActionRateLimit.set(key, Date.now());
  return false;
}

/**
 * Return a stable, normalised key for a venue.
 * @param {string} name
 * @param {string} [url]
 * @returns {string}
 */
function getVenueKey(name, url) {
  const n = (name || '').toLowerCase().trim();
  const u = (url  || '').toLowerCase().trim().replace(/\/$/, '');
  return `${n}||${u}`;
}

/**
 * Apply crowd-sourced user-report aggregates to a list of enriched venues.
 * Modifies kitchen_status.confidence_score in place (non-destructively on the
 * cached base venues — we apply this only to response copies).
 *
 * Rules:
 *  - Majority "yes" (still serving) → boost confidence toward aggregate score
 *  - Majority "no" (kitchen closed) → suppress confidence using aggregate score
 *  - Business emergency closures (venue_claimed) are absolute and are handled
 *    upstream in determineWinningHours — we never override them here.
 *
 * @param {Array} venues
 * @returns {Array}
 */
function applyUserReportEnrichment(venues) {
  if (!venues || venues.length === 0) return venues;
  const now = new Date();
  return venues.map((v) => {
    const vKey = getVenueKey(v.name, v.url);

    // Business emergency closure always wins — it is an absolute override that
    // outweighs all user reports and all scraped data.
    const closure = emergencyClosureStore.get(vKey);
    if (closure && closure.closed_until > now) {
      return {
        ...v,
        serving: false,
        kitchen_status: {
          ...v.kitchen_status,
          confidence_score: 1.0,
          is_verified: true,
          verified_via: 'venue_claimed',
          emergency_closure: true,
          emergency_reason: closure.reason || null,
          user_report_summary: null,
        },
      };
    }

    const reports = userReportStore.get(vKey) || [];
    const agg = aggregateUserReports(reports);
    if (!agg) return v;

    let confidenceScore = v.kitchen_status ? v.kitchen_status.confidence_score : 0;
    if (agg.is_serving_consensus) {
      // Users confirm kitchen is open — raise confidence toward the aggregate score
      confidenceScore = parseFloat(Math.min(1.0, Math.max(confidenceScore, agg.score)).toFixed(2));
    } else {
      // Users report kitchen is closed — suppress confidence
      confidenceScore = parseFloat(Math.max(0, Math.min(confidenceScore, 1.0 - agg.score)).toFixed(2));
    }

    return {
      ...v,
      kitchen_status: {
        ...v.kitchen_status,
        confidence_score: confidenceScore,
        is_verified: isConfidenceVerified(confidenceScore),
        user_report_summary: {
          vote_count: agg.vote_count,
          yes_count: agg.yes_count,
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Business-owner claim system (paid via Stripe)
// ---------------------------------------------------------------------------

/**
 * In-memory store for active emergency closures set by verified business owners.
 * Key: venueKey, value: { reason: string|null, closed_until: Date }
 *
 * Checked on every search response (including cache hits) in applyUserReportEnrichment.
 */
const emergencyClosureStore = new Map();

/**
 * In-memory registry of paid business claims.
 * Key: venueKey, value: { venueKey, paidAt, stripeSessionId }
 *
 * When DATABASE_URL is set this is backed by the kitchen_hours_log table;
 * the in-memory copy is a fast-access cache.
 */
const businessClaimStore = new Map();
const BUSINESS_CLAIM_PRICE_ID = process.env.BUSINESS_CLAIM_PRICE_ID || 'price_business_claim';
const BUSINESS_JWT_SECRET     = process.env.BUSINESS_JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BUSINESS_JWT_SECRET must be set in production');
  }
  console.warn('[security] BUSINESS_JWT_SECRET not set — using insecure default. Set this env var in production.');
  return 'business-jwt-secret-change-in-production';
})();
const BUSINESS_JWT_TTL = '1y'; // business tokens are long-lived

/**
 * Sign a JWT granting a business owner access to manage their venue.
 * @param {string} venueKey
 * @param {string} stripeSessionId
 * @returns {string}
 */
function signBusinessToken(venueKey, stripeSessionId) {
  return jwt.sign({ venueKey, stripeSessionId, role: 'business_owner' }, BUSINESS_JWT_SECRET, { expiresIn: BUSINESS_JWT_TTL });
}

/**
 * Verify a business token from the Authorization header.
 * Returns the decoded payload or null.
 * @param {import('express').Request} req
 * @returns {{ venueKey: string, stripeSessionId: string }|null}
 */
function verifyBusinessToken(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, BUSINESS_JWT_SECRET);
    return payload.role === 'business_owner' ? payload : null;
  } catch {
    return null;
  }
}

function isValidAdToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expiry = adTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    adTokens.delete(token);
    return false;
  }
  return true;
}

function consumeAdToken(token) {
  adTokens.delete(token);
}

// Expose for testing
app._searchCounters = searchCounters;
app._adTokens = adTokens;
app._userReportStore = userReportStore;
app._userReportRateLimit = userReportRateLimit;
app._businessClaimStore = businessClaimStore;
app._emergencyClosureStore = emergencyClosureStore;
app._businessActionRateLimit = businessActionRateLimit;

app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Return true only when url uses http/https and does not target a
 * private, loopback, or link-local network address.
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const h = parsed.hostname.toLowerCase();
  // Block loopback, private (RFC 1918), link-local, and unspecified addresses
  if (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === '[::1]' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h)
  ) {
    return false;
  }

  return true;
}

/**
 * GET /api/ad-token
 *
 * Called by the client after a user watches an advertisement.
 * Returns a short-lived token that grants one additional search.
 */
app.get('/api/ad-token', (_req, res) => {
  const token = generateToken();
  adTokens.set(token, Date.now() + AD_TOKEN_TTL_MS);
  return res.json({ token });
});

/**
 * GET /api/search?location=Brooklyn,NY&name=Crown&servingUntil=10pm&limit=10&adToken=...
 *
 * Search for venues serving food.  Supports filtering by:
 *   - location  (city / neighbourhood)
 *   - name      (specific restaurant name)
 *   - servingUntil (e.g. "10pm" — included in the Firecrawl query)
 *
 * Ad-gate: each IP gets FREE_SEARCHES_PER_IP free searches per day.
 * Subsequent searches require a valid adToken obtained from /api/ad-token.
 *
 * Results are cached for 10 minutes.
 */
app.get('/api/search', async (req, res) => {
  const { location, name, servingUntil, limit, adToken, utcOffset } = req.query;

  // At least one search dimension must be provided
  const hasLocation = location && typeof location === 'string' && location.trim();
  const hasName = name && typeof name === 'string' && name.trim();

  if (!hasLocation && !hasName) {
    return res.status(400).json({ error: 'Provide at least a location or restaurant name to search.' });
  }

  if (hasLocation && location.length > 200) {
    return res.status(400).json({ error: 'location is too long (max 200 characters)' });
  }

  if (hasName && name.length > 200) {
    return res.status(400).json({ error: 'name is too long (max 200 characters)' });
  }

  if (servingUntil && typeof servingUntil === 'string' && servingUntil.length > 50) {
    return res.status(400).json({ error: 'servingUntil is too long (max 50 characters)' });
  }

  // Parse the user's UTC offset (minutes east of UTC, e.g. -300 for EST).
  // Clamp to a valid range (±840 minutes covers all real-world offsets).
  const parsedUtcOffset = Math.max(-840, Math.min(840, parseInt(utcOffset, 10) || 0));

  // Build a stable cache key from all search dimensions
  const cacheKey = [
    (location || '').toLowerCase().trim(),
    (name || '').toLowerCase().trim(),
    (servingUntil || '').toLowerCase().trim(),
  ].join('|');

  // Serve from cache without counting against the ad-gate quota.
  // User-report enrichment is applied live on every response so that
  // votes cast after a result is cached still influence the output.
  const cached = venueStore.get(cacheKey);
  if (cached) {
    return res.json({ venues: applyUserReportEnrichment(cached), fromCache: true });
  }

  // Ad-gate check — only applied to fresh (non-cached) searches
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const searchCount = getSearchCount(ip);
  const needsAd = searchCount >= FREE_SEARCHES_PER_IP;

  if (needsAd) {
    if (!isValidAdToken(adToken)) {
      return res.status(402).json({
        error: 'ad_required',
        message: 'Watch a brief ad to continue searching.',
      });
    }
    consumeAdToken(adToken);
  }

  try {
    let venues;
    if (hasLocation && process.env.GOOGLE_PLACES_API_KEY) {
      // Hybrid pipeline: Google Places entity verification → Facebook scraping
      venues = await runHybridPipeline(
        { location: location || '', name: name || '', servingUntil: servingUntil || '' },
        { limit: parseInt(limit, 10) || 10, utcOffsetMinutes: parsedUtcOffset },
      );
    } else {
      // Legacy pipeline: Firecrawl web search
      venues = await searchVenues(
        { location: location || '', name: name || '', servingUntil: servingUntil || '' },
        { limit: parseInt(limit, 10) || 10, utcOffsetMinutes: parsedUtcOffset },
      );
    }

    // Sort order: regular venues first (serving before not-serving), 24-hour chains last.
    // 24-hr establishments are well-known, so regular results get priority placement
    // while 24-hr venues still appear for completeness.
    venues.sort((a, b) => {
      if (a.is24Hours !== b.is24Hours) return a.is24Hours ? 1 : -1;
      if (a.serving === true && b.serving !== true) return -1;
      if (b.serving === true && a.serving !== true) return 1;
      return 0;
    });

    // Enrich venues with affiliate links, confidence scores, and kitchen_status
    venues = venues.map((v) => {
      const source = mapHoursSourceToScrapeSource(v.hoursSource);
      const rawConfidence = computeRawConfidence(v, source);
      const baseWeight = SOURCE_WEIGHTS[source] || DEFAULT_SOURCE_WEIGHT;
      const confidenceScore = parseFloat((baseWeight * rawConfidence).toFixed(2));

      return {
        ...v,
        affiliate_links: generateAffiliateLinks(v),
        kitchen_status: {
          closes_at: v.closesAt || null,
          confidence_score: confidenceScore,
          verified_via: v.hoursSource || 'unknown',
          is_verified: isConfidenceVerified(confidenceScore),
        },
      };
    });

    // Persist to database if available (CQRS write path: scrape → ledger → cache)
    if (dbClient.isDbAvailable()) {
      for (const v of venues) {
        try {
          await dbClient.ingestVenue(v);
        } catch (_dbErr) {
          // Database persistence is best-effort; don't fail the search
        }
      }
    }

    venueStore.set(cacheKey, venues);
    incrementSearchCount(ip);
    // Apply user-report adjustments after caching base results so that
    // reports always reflect the latest votes, not a snapshot from cache time.
    return res.json({ venues: applyUserReportEnrichment(venues), fromCache: false });
  } catch (err) {
    console.error('[search error]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/user-report
 * Body: { "venue_name": "...", "venue_url": "...", "is_serving": true|false }
 *
 * Crowd-sourced yes/no: "Is this kitchen still taking orders right now?"
 * Reports are stored in memory and applied live to every search response.
 * Rate-limited to one report per IP + venue combination per 5 minutes.
 */
app.post('/api/user-report', (req, res) => {
  const { venue_name, venue_url, is_serving } = req.body;

  if (!venue_name || typeof venue_name !== 'string' || !venue_name.trim()) {
    return res.status(400).json({ error: 'venue_name is required' });
  }
  if (venue_name.length > 255) {
    return res.status(400).json({ error: 'venue_name is too long (max 255 characters)' });
  }
  if (typeof is_serving !== 'boolean') {
    return res.status(400).json({ error: 'is_serving must be a boolean' });
  }

  const ip       = req.ip || req.socket.remoteAddress || 'unknown';
  const venueKey = getVenueKey(venue_name, venue_url || '');
  const rlKey    = `${ip}:${venueKey}`;
  const lastAt   = userReportRateLimit.get(rlKey);

  if (lastAt && Date.now() - lastAt < USER_REPORT_COOLDOWN_MS) {
    return res.status(429).json({ error: 'You have already reported this venue recently. Please wait before reporting again.' });
  }

  userReportRateLimit.set(rlKey, Date.now());

  const existing = userReportStore.get(venueKey) || [];
  existing.push({ is_serving, observed_at: new Date() });
  userReportStore.set(venueKey, existing);

  const yesCount  = existing.filter((r) => r.is_serving).length;
  const voteCount = existing.length;

  return res.json({ ok: true, vote_count: voteCount, yes_count: yesCount });
});

// ---------------------------------------------------------------------------
// Business-owner claim & hours management (paid via Stripe)
// ---------------------------------------------------------------------------

/**
 * POST /api/business/create-checkout-session
 * Body: { "venue_name": "...", "venue_url": "...", "email": "..." }
 *
 * Creates a Stripe Checkout session for a business to claim their venue
 * and gain the ability to set authoritative hours and post emergency closures.
 *
 * Price: configured via BUSINESS_CLAIM_PRICE_ID env var (default: one-time $9.99).
 *
 * Requires STRIPE_SECRET_KEY to be set. Returns 503 when Stripe is not configured.
 */
app.post('/api/business/create-checkout-session', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Business claiming is not currently available.' });
  }

  const { venue_name, venue_url, email } = req.body;

  if (!venue_name || typeof venue_name !== 'string' || !venue_name.trim()) {
    return res.status(400).json({ error: 'venue_name is required' });
  }
  if (venue_name.length > 255) {
    return res.status(400).json({ error: 'venue_name is too long (max 255 characters)' });
  }
  if (email && (typeof email !== 'string' || email.length > 254)) {
    return res.status(400).json({ error: 'email is invalid' });
  }

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const venueKey = getVenueKey(venue_name, venue_url || '');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price: BUSINESS_CLAIM_PRICE_ID,
        quantity: 1,
      }],
      customer_email: email || undefined,
      metadata: { venueKey, venue_name, venue_url: venue_url || '' },
      success_url: `${process.env.PUBLIC_URL || 'https://letsnarf.com'}/api/business/activate?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.PUBLIC_URL || 'https://letsnarf.com'}/search.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[business checkout error]', err.message);
    return res.status(502).json({ error: 'Failed to create checkout session.' });
  }
});

/**
 * GET /api/business/activate?session_id=...
 *
 * Stripe redirects the business owner here after a successful payment.
 * Verifies the Stripe session, registers the claim, and returns a
 * long-lived JWT the owner uses to manage their listing.
 *
 * Requires STRIPE_SECRET_KEY to be set.
 */
app.get('/api/business/activate', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Business claiming is not currently available.' });
  }

  const { session_id } = req.query;
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    const venueKey  = session.metadata.venueKey;
    const venueName = session.metadata.venue_name;
    const venueUrl  = session.metadata.venue_url;

    businessClaimStore.set(venueKey, {
      venueKey,
      venueName,
      venueUrl,
      paidAt: new Date(),
      stripeSessionId: session.id,
    });

    const token = signBusinessToken(venueKey, session.id);
    return res.json({ ok: true, token, venue_name: venueName });
  } catch (err) {
    console.error('[business activate error]', err.message);
    return res.status(502).json({ error: 'Failed to activate business claim.' });
  }
});

/**
 * POST /api/business/hours
 * Headers: Authorization: Bearer <business_token>
 * Body: { "day_of_week": 0-6, "kitchen_open": "HH:MM", "kitchen_close": "HH:MM" }
 *
 * Set authoritative kitchen hours for the claimed venue.
 * This writes a `venue_claimed` entry to the ledger which wins over all
 * scraped sources in the precedence engine.
 *
 * Requires a valid business JWT issued by /api/business/activate.
 */
app.post('/api/business/hours', async (req, res) => {
  const owner = verifyBusinessToken(req);
  if (!owner) {
    return res.status(401).json({ error: 'Valid business owner token required.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isBusinessActionRateLimited(ip, '/api/business/hours')) {
    return res.status(429).json({ error: 'Too many requests. Please wait before updating hours again.' });
  }

  const { day_of_week, kitchen_open, kitchen_close } = req.body;

  if (typeof day_of_week !== 'number' || day_of_week < 0 || day_of_week > 6) {
    return res.status(400).json({ error: 'day_of_week must be a number between 0 and 6' });
  }
  const timeRe = /^\d{2}:\d{2}$/;
  if (!kitchen_open  || !timeRe.test(kitchen_open)) {
    return res.status(400).json({ error: 'kitchen_open must be in HH:MM format' });
  }
  if (!kitchen_close || !timeRe.test(kitchen_close)) {
    return res.status(400).json({ error: 'kitchen_close must be in HH:MM format' });
  }

  const claim = businessClaimStore.get(owner.venueKey);
  if (!claim) {
    return res.status(403).json({ error: 'No active claim found for this venue. Please complete payment first.' });
  }

  // Persist to DB if available — this is a venue_claimed write on the CQRS path
  if (dbClient.isDbAvailable()) {
    try {
      const venueProxy = {
        name: claim.venueName,
        url:  claim.venueUrl,
        hoursSource: 'venue_claimed',
        hourBlocks: [{
          day:   day_of_week,
          open:  timeToMinutes(kitchen_open),
          close: timeToMinutes(kitchen_close),
        }],
      };
      await dbClient.ingestVenue(venueProxy);
    } catch (_dbErr) {
      // Best-effort; in-memory claim is still recorded
    }
  }

  return res.json({ ok: true, message: 'Hours updated. Changes will appear in search results immediately.' });
});

/**
 * POST /api/business/close-now
 * Headers: Authorization: Bearer <business_token>
 * Body: { "reason": "optional human-readable reason", "reopen_at": "HH:MM" (optional) }
 *
 * Emergency closure: marks the venue as closed for the rest of the night.
 * This is an absolute override — it outweighs all user reports and all
 * scraped data sources until the reopen_at time (or 06:00 the next day).
 *
 * Requires a valid business JWT issued by /api/business/activate.
 */
app.post('/api/business/close-now', async (req, res) => {
  const owner = verifyBusinessToken(req);
  if (!owner) {
    return res.status(401).json({ error: 'Valid business owner token required.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isBusinessActionRateLimited(ip, '/api/business/close-now')) {
    return res.status(429).json({ error: 'Too many requests. Please wait before submitting another closure.' });
  }

  const claim = businessClaimStore.get(owner.venueKey);
  if (!claim) {
    return res.status(403).json({ error: 'No active claim found for this venue. Please complete payment first.' });
  }

  const { reason, reopen_at } = req.body;

  // Determine when the emergency closure expires
  const now = new Date();
  let closedUntil;
  if (reopen_at && /^\d{2}:\d{2}$/.test(reopen_at)) {
    const [h, m] = reopen_at.split(':').map(Number);
    closedUntil = new Date(now);
    closedUntil.setHours(h, m, 0, 0);
    if (closedUntil <= now) closedUntil.setDate(closedUntil.getDate() + 1); // next occurrence
  } else {
    // Default: closed until 06:00 the next day
    closedUntil = new Date(now);
    closedUntil.setDate(closedUntil.getDate() + 1);
    closedUntil.setHours(6, 0, 0, 0);
  }

  // Record closure in the emergency store — applyUserReportEnrichment checks this
  // on every search response, so cached results will reflect the closure instantly.
  emergencyClosureStore.set(owner.venueKey, { reason: reason || null, closed_until: closedUntil });
  businessClaimStore.set(owner.venueKey, claim);

  // Write an emergency closure log entry to the DB if available
  if (dbClient.isDbAvailable()) {
    try {
      const venueProxy = {
        name: claim.venueName,
        url:  claim.venueUrl,
        hoursSource: 'venue_claimed',
        hourBlocks: [],
        raw_scrape_payload: {
          emergency_closure: true,
          reason: reason || null,
          closed_until: closedUntil.toISOString(),
        },
      };
      await dbClient.ingestVenue(venueProxy);
    } catch (_dbErr) {
      // Best-effort
    }
  }

  return res.json({
    ok: true,
    message: `Emergency closure recorded. Venue will appear as closed until ${closedUntil.toISOString()}.`,
    closed_until: closedUntil.toISOString(),
  });
});

/**
 * Convert a HH:MM time string to minutes since midnight.
 * @param {string} time
 * @returns {number}
 */
function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * POST /api/scrape
 * Body: { "url": "https://example.com" }
 *
 * Scrape a specific venue URL for its food-service hours.
 */
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url body field is required' });
  }

  if (url.length > 2048) {
    return res.status(400).json({ error: 'url is too long (max 2048 characters)' });
  }

  if (!isPublicUrl(url)) {
    return res.status(400).json({ error: 'url must use http or https and must not target a private or loopback address' });
  }

  try {
    const venue = await scrapeVenue(url);
    return res.json({ venue });
  } catch (err) {
    console.error('[scrape error]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/v1/venues/open-now?lat=...&lng=...&radius_miles=5&time_override=HH:MM
 *
 * Mobile-optimized endpoint: "I am here, it is this time, what is open?"
 * Reads from the current_kitchen_hours cache table (CQRS read path).
 * Falls back to in-memory cache + pipeline if DB is not available.
 */
app.get('/api/v1/venues/open-now', async (req, res) => {
  const { lat, lng, radius_miles, time_override, limit } = req.query;

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);

  if (isNaN(parsedLat) || isNaN(parsedLng)) {
    return res.status(400).json({ error: 'lat and lng query parameters are required and must be valid numbers.' });
  }

  if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) {
    return res.status(400).json({ error: 'lat must be between -90 and 90; lng between -180 and 180.' });
  }

  const radiusMiles = Math.max(0.1, Math.min(50, parseFloat(radius_miles) || 5));
  const maxResults = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));

  // Determine current time (or use override for testing)
  let now;
  if (time_override && /^\d{2}:\d{2}$/.test(time_override)) {
    now = time_override;
  } else {
    const d = new Date();
    now = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  const dayOfWeek = new Date().getUTCDay();

  // Try the CQRS read path (database)
  if (dbClient.isDbAvailable()) {
    try {
      const rows = await dbClient.queryOpenVenues({
        lat: parsedLat,
        lng: parsedLng,
        radiusMiles,
        dayOfWeek,
        currentTime: now,
        limit: maxResults,
      });

      const venues = rows.map((row) => {
        const confidenceScore = parseFloat(row.overall_confidence_score) || 0;
        const MILES_PER_DEG = 69.0;
        const distMiles = Math.sqrt(
          Math.pow((row.lat - parsedLat) * MILES_PER_DEG, 2) +
          Math.pow((row.lng - parsedLng) * MILES_PER_DEG * Math.cos(parsedLat * Math.PI / 180), 2)
        );

        return {
          id: row.id,
          name: row.name,
          category: row.category,
          distance_miles: parseFloat(distMiles.toFixed(1)),
          kitchen_status: {
            closes_at: row.kitchen_close_time,
            confidence_score: confidenceScore,
            verified_via: row.best_source,
            is_verified: isConfidenceVerified(confidenceScore),
          },
          affiliate_links: generateAffiliateLinks({
            name: row.name,
            description: row.address,
            city: row.city,
          }),
        };
      });

      return res.json({ venues });
    } catch (dbErr) {
      // Fall through to in-memory fallback
      console.error('[open-now db error]', dbErr.message);
    }
  }

  // Fallback: return empty when no DB (the search endpoint populates data)
  return res.json({
    venues: [],
    message: 'Database not configured. Use /api/search to discover venues.',
  });
});

/**
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

if (require.main === module) {
  // Initialize database connection if DATABASE_URL is set
  if (process.env.DATABASE_URL) {
    const dbOk = dbClient.initDb();
    console.log(dbOk ? '[db] PostgreSQL connected' : '[db] PostgreSQL connection failed — using in-memory cache');
  }

  app.listen(PORT, () => {
    console.log(`Still Serving Food server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
