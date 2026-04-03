'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { searchVenues, scrapeVenue } = require('./scraper');
const venueStore = require('./venueStore');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe is optional — the app works without it; payment routes return 503 when unconfigured.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Stripe webhooks must receive the raw request body for signature verification.
// This middleware must be registered before express.json().
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// CORS — allow the static frontend hosted on letsnarf.com to call the API
const ALLOWED_ORIGINS = new Set([
  'https://letsnarf.com',
  'https://www.letsnarf.com',
  'capacitor://localhost', // Capacitor native app wrapper
  'http://localhost',      // local development
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Subscriber-Token');
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
      // Also allow Stripe.js for future embedded payment elements
      "script-src 'self' https://pagead2.googlesyndication.com https://partner.googleadservices.com https://js.stripe.com",
      // AdSense injects inline styles; 'unsafe-inline' is required for it to render correctly
      "style-src 'self' 'unsafe-inline'",
      // Allow ad-creative images from Google's CDNs
      "img-src 'self' data: https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com",
      // Allow AdSense to phone home for ad delivery and measurement; allow Stripe API calls
      "connect-src 'self' https://pagead2.googlesyndication.com https://tpc.googlesyndication.com https://adservice.google.com https://api.stripe.com",
      // AdSense renders creatives inside sandboxed iframes on these origins; Stripe Checkout is an external redirect
      "frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://js.stripe.com https://hooks.stripe.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://checkout.stripe.com",
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

/**
 * ── Subscriber system ────────────────────────────────────────────────────────
 *
 * Users pay a one-time $4.99 fee via Stripe Checkout to unlock 100 searches.
 * On successful payment the client calls /api/activate with the Stripe session
 * ID; the server verifies the payment, generates a signed JWT and returns it.
 * The client stores the JWT in localStorage and sends it as the `subscriberToken`
 * query param on each /api/search request so the ad-gate is bypassed.
 *
 * Storage is in-memory: on server restart subscribers receive a fresh quota of
 * SUBSCRIBER_SEARCHES (acceptable while no database is configured).
 *
 * Pricing rationale: $4.99 is an impulse-purchase price point for the target
 * demographic (urban adults 21–35 searching for late-night kitchen hours).  It
 * sits below the cost of a single drink at the venues being searched, and covers
 * Firecrawl scraping costs (~$0.03–0.05/search) with a reasonable margin across
 * the 100-search bundle.
 */
const SUBSCRIBER_SEARCHES = 100; // searches included per one-time $4.99 payment

// Map: subscriberId (JWT sub claim) -> number of searches used
const subscriberSearches = new Map();

// Set of Stripe session IDs that have already been activated to prevent double-redemption
const activatedSessions = new Set();

// JWT signing secret — set SUBSCRIBER_SECRET in production to a long random string
const SUBSCRIBER_SECRET = process.env.SUBSCRIBER_SECRET || 'change-me-in-production';

if (!process.env.SUBSCRIBER_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[WARN] SUBSCRIBER_SECRET is not set. Using an insecure default. ' +
    'Set this environment variable to a long random string in production.',
  );
}

/**
 * Simple per-IP rate limiter: allows at most `maxRequests` in a rolling `windowMs`
 * window.  Returns true if the request should be allowed, false to reject.
 * @param {Map<string, {count: number, resetAt: number}>} store
 * @param {string} ip
 * @param {number} maxRequests
 * @param {number} windowMs
 * @returns {boolean}
 */
function checkRateLimit(store, ip, maxRequests, windowMs) {
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count += 1;
  return true;
}

// Rate-limit stores for auth-sensitive endpoints
const activateRateLimits = new Map();    // /api/activate — 10 per IP per hour
const subscriberStatusLimits = new Map(); // /api/subscriber-status — 120 per IP per hour
const searchRateLimits = new Map();       // /api/search — 60 per IP per hour (fresh searches)

function verifySubscriberToken(token) {
  if (!token || typeof token !== 'string') return { valid: false };
  try {
    const payload = jwt.verify(token, SUBSCRIBER_SECRET);
    if (!payload.sub || typeof payload.sub !== 'string') return { valid: false };
    return { valid: true, subscriberId: payload.sub, email: payload.email || '' };
  } catch {
    return { valid: false };
  }
}

// Expose for testing
app._subscriberSearches = subscriberSearches;
app._activatedSessions = activatedSessions;
app._activateRateLimits = activateRateLimits;
app._subscriberStatusLimits = subscriberStatusLimits;
app._searchRateLimits = searchRateLimits;

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
  // Coerce query params to strings to guard against array injection (?p=a&p=b)
  const location = typeof req.query.location === 'string' ? req.query.location : '';
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const servingUntil = typeof req.query.servingUntil === 'string' ? req.query.servingUntil : '';
  const limit = typeof req.query.limit === 'string' ? req.query.limit : '';
  const adToken = typeof req.query.adToken === 'string' ? req.query.adToken : '';
  // Subscriber token is sent in a request header to avoid appearing in server logs / history
  const subscriberToken = typeof req.headers['x-subscriber-token'] === 'string'
    ? req.headers['x-subscriber-token']
    : '';

  // At least one search dimension must be provided
  const hasLocation = location.trim().length > 0;
  const hasName = name.trim().length > 0;

  if (!hasLocation && !hasName) {
    return res.status(400).json({ error: 'Provide at least a location or restaurant name to search.' });
  }

  if (hasLocation && location.length > 200) {
    return res.status(400).json({ error: 'location is too long (max 200 characters)' });
  }

  if (hasName && name.length > 200) {
    return res.status(400).json({ error: 'name is too long (max 200 characters)' });
  }

  if (servingUntil && servingUntil.length > 50) {
    return res.status(400).json({ error: 'servingUntil is too long (max 50 characters)' });
  }

  // Resolve subscriber status before checking the cache so quota is enforced upfront
  const subscriberResult = verifySubscriberToken(subscriberToken);
  const isSubscriber = subscriberResult.valid;

  if (isSubscriber) {
    const used = subscriberSearches.get(subscriberResult.subscriberId) || 0;
    if (used >= SUBSCRIBER_SEARCHES) {
      return res.status(402).json({
        error: 'search_limit_reached',
        message: 'You have used all your searches. Purchase another pass to continue.',
      });
    }
  }

  // Build a stable cache key from all search dimensions
  const cacheKey = [
    (location || '').toLowerCase().trim(),
    (name || '').toLowerCase().trim(),
    (servingUntil || '').toLowerCase().trim(),
  ].join('|');

  // Serve from cache without counting against any quota
  const cached = venueStore.get(cacheKey);
  if (cached) {
    return res.json({ venues: cached, fromCache: true });
  }

  // Rate-limit fresh (non-cached) search requests — 60 per IP per hour.
  // Runs after the cache check so serving cached results does not consume quota.
  const searchIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(searchRateLimits, searchIp, 60, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many searches. Please wait before trying again.' });
  }

  // Ad-gate check — only applied to non-subscribers on fresh (non-cached) searches
  if (!isSubscriber) {
    const searchCount = getSearchCount(searchIp);
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
  }

  try {
    const venues = await searchVenues(
      { location: location || '', name: name || '', servingUntil: servingUntil || '' },
      { limit: parseInt(limit, 10) || 10 },
    );
    venueStore.set(cacheKey, venues);

    if (isSubscriber) {
      const used = subscriberSearches.get(subscriberResult.subscriberId) || 0;
      subscriberSearches.set(subscriberResult.subscriberId, used + 1);
    } else {
      incrementSearchCount(searchIp);
    }

    return res.json({ venues, fromCache: false });
  } catch (err) {
    console.error('[search error]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

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
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * POST /api/create-checkout-session
 *
 * Creates a Stripe Checkout session for the one-time $4.99 subscriber pass.
 * Returns { url } — redirect the user's browser to this URL to complete payment.
 * On success Stripe redirects to /success.html?session_id={CHECKOUT_SESSION_ID}.
 */
app.post('/api/create-checkout-session', async (_req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payment system not configured.' });
  }

  const appUrl = (process.env.APP_URL || 'https://letsnarf.com').replace(/\/$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${appUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/cancel.html`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout error]', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

/**
 * GET /api/activate?session_id=...
 *
 * Called by success.html after Stripe redirects back.  Verifies the payment
 * with Stripe, issues a signed JWT subscriber token, and returns it to the
 * client which stores it in localStorage.
 */
app.get('/api/activate', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(activateRateLimits, ip, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many activation attempts. Please try again later.' });
  }

  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';

  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  if (!stripe) {
    return res.status(503).json({ error: 'Payment system not configured.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    // Prevent duplicate activation of the same Stripe session
    if (activatedSessions.has(sessionId)) {
      return res.status(409).json({ error: 'This payment session has already been activated.' });
    }

    // Generate a unique subscriber ID and mint a signed JWT.
    const subscriberId = crypto.randomUUID();
    activatedSessions.add(sessionId);
    subscriberSearches.set(subscriberId, 0);

    const token = jwt.sign(
      { sub: subscriberId, email: session.customer_details?.email || '' },
      SUBSCRIBER_SECRET,
    );

    return res.json({ token, searchesTotal: SUBSCRIBER_SEARCHES });
  } catch (err) {
    console.error('[activate error]', err.message);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

/**
 * GET /api/subscriber-status
 *
 * Returns the number of remaining searches for the authenticated subscriber.
 * Expects the subscriber JWT as the `subscriberToken` query parameter.
 */
app.get('/api/subscriber-status', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(subscriberStatusLimits, ip, 120, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const token = typeof req.headers['x-subscriber-token'] === 'string'
    ? req.headers['x-subscriber-token']
    : '';
  const result = verifySubscriberToken(token);

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid or missing subscriber token.' });
  }

  const used = subscriberSearches.get(result.subscriberId) || 0;
  return res.json({
    searchesRemaining: Math.max(0, SUBSCRIBER_SEARCHES - used),
    searchesTotal: SUBSCRIBER_SEARCHES,
  });
});

/**
 * POST /api/stripe-webhook
 *
 * Receives signed events from Stripe.  Currently used for audit logging;
 * token issuance is handled synchronously via /api/activate.
 * Set STRIPE_WEBHOOK_SECRET to the signing secret from the Stripe dashboard
 * (Developers → Webhooks → your endpoint → Signing secret).
 */
app.post('/api/stripe-webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    // Webhook not configured — return 200 so Stripe doesn't retry
    return res.sendStatus(200);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log(
      `[webhook] Payment confirmed — session: ${session.id}, customer: ${session.customer_details?.email || 'unknown'}`,
    );
  }

  return res.sendStatus(200);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Still Serving Food server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
