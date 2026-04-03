'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { searchVenues, scrapeVenue } = require('./scraper');
const venueStore = require('./venueStore');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS — allow the static frontend hosted on letsnarf.com to call the API
const ALLOWED_ORIGINS = new Set(['https://letsnarf.com', 'https://www.letsnarf.com']);

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
  const { location, name, servingUntil, limit, adToken } = req.query;

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

  if (servingUntil && servingUntil.length > 50) {
    return res.status(400).json({ error: 'servingUntil is too long (max 50 characters)' });
  }

  // Build a stable cache key from all search dimensions
  const cacheKey = [
    (location || '').toLowerCase().trim(),
    (name || '').toLowerCase().trim(),
    (servingUntil || '').toLowerCase().trim(),
  ].join('|');

  // Serve from cache without counting against the ad-gate quota
  const cached = venueStore.get(cacheKey);
  if (cached) {
    return res.json({ venues: cached, fromCache: true });
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
    const venues = await searchVenues(
      { location: location || '', name: name || '', servingUntil: servingUntil || '' },
      { limit: parseInt(limit, 10) || 10 },
    );

    // Sort order: regular venues first (serving before not-serving), 24-hour chains last.
    // 24-hr establishments are well-known, so regular results get priority placement
    // while 24-hr venues still appear for completeness.
    venues.sort((a, b) => {
      if (a.is24Hours !== b.is24Hours) return a.is24Hours ? 1 : -1;
      if (a.serving === true && b.serving !== true) return -1;
      if (b.serving === true && a.serving !== true) return 1;
      return 0;
    });

    venueStore.set(cacheKey, venues);
    incrementSearchCount(ip);
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Still Serving Food server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
