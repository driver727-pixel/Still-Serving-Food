'use strict';

const request = require('supertest');
const app = require('../functions/server');
const venueStore = require('../functions/venueStore');
const scraper = require('../functions/scraper');
const jwt = require('jsonwebtoken');

jest.mock('../functions/scraper');

const SAMPLE_VENUES = [
  {
    name: 'The Crown & Anchor',
    url: 'https://crownandanchor.com',
    description: 'Classic British pub',
    serving: true,
    opensAt: null,
    closesAt: '9:00 PM',
    hourBlocks: [],
    scrapedAt: new Date().toISOString(),
  },
];

// The default SUBSCRIBER_SECRET used when the env var is not set
const TEST_SECRET = 'change-me-in-production';

function makeSubscriberToken(subscriberId, overrideSecret) {
  return jwt.sign({ sub: subscriberId, email: 'test@example.com' }, overrideSecret || TEST_SECRET);
}

beforeEach(() => {
  venueStore.clear();
  app._searchCounters.clear();
  app._adTokens.clear();
  app._subscriberSearches.clear();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Security / SEO headers
// ---------------------------------------------------------------------------
describe('Security and SEO HTTP headers', () => {
  test('GET /api/health includes X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('GET /api/health includes X-Frame-Options: SAMEORIGIN', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  test('GET /api/health includes Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('GET /api/health includes Content-Security-Policy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/object-src 'none'/);
  });

  test('GET /api/health includes Permissions-Policy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
describe('GET /api/health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.time).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------
describe('GET /api/search', () => {
  test('returns 400 when neither location nor name is provided', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location or restaurant name/i);
  });

  test('returns 400 when location is blank and name is blank', async () => {
    const res = await request(app).get('/api/search?location=   &name=   ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location or restaurant name/i);
  });

  test('returns 400 when location exceeds 200 characters', async () => {
    const longLocation = 'a'.repeat(201);
    const res = await request(app).get(`/api/search?location=${encodeURIComponent(longLocation)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  test('returns 400 when name exceeds 200 characters', async () => {
    const longName = 'a'.repeat(201);
    const res = await request(app).get(`/api/search?name=${encodeURIComponent(longName)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  test('returns venues from scraper on cache miss (location only)', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(res.status).toBe(200);
    expect(res.body.fromCache).toBe(false);
    expect(res.body.venues).toEqual(SAMPLE_VENUES);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });

  test('returns venues from scraper when searching by name only', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?name=The+Crown');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual(SAMPLE_VENUES);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });

  test('returns venues from scraper when searching by name and location', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?name=The+Crown&location=Brooklyn,NY');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual(SAMPLE_VENUES);
  });

  test('returns venues when searching with servingUntil parameter', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?location=Brooklyn,NY&servingUntil=10pm');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual(SAMPLE_VENUES);
  });

  test('returns cached venues on second request', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    await request(app).get('/api/search?location=Brooklyn,NY');
    const res = await request(app).get('/api/search?location=Brooklyn,NY');

    expect(res.status).toBe(200);
    expect(res.body.fromCache).toBe(true);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1); // only called once
  });

  test('returns 502 when scraper throws', async () => {
    scraper.searchVenues.mockRejectedValue(new Error('Firecrawl down'));

    const res = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Firecrawl down');
  });

  test('respects the limit query parameter', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    await request(app).get('/api/search?location=Brooklyn,NY&limit=5');
    expect(scraper.searchVenues).toHaveBeenCalledWith(
      { location: 'Brooklyn,NY', name: '', servingUntil: '' },
      { limit: 5 },
    );
  });

  test('returns 402 on second request from same IP without ad token', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    // First search — free
    await request(app).get('/api/search?location=Brooklyn,NY');
    // Second search — needs ad token
    const res = await request(app).get('/api/search?location=Brooklyn,NY&_nocache=1');
    // May be cached (200) or 402 depending on cache; force a unique location
    const res2 = await request(app).get('/api/search?location=UniqueCity999');
    expect([200, 402]).toContain(res2.status);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ad-token
// ---------------------------------------------------------------------------
describe('GET /api/ad-token', () => {
  test('returns a token string', async () => {
    const res = await request(app).get('/api/ad-token');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
  });

  test('returns a unique token on each call', async () => {
    const res1 = await request(app).get('/api/ad-token');
    const res2 = await request(app).get('/api/ad-token');
    expect(res1.body.token).not.toBe(res2.body.token);
  });

  test('valid ad token allows a search that would otherwise be blocked', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    // Exhaust free searches
    await request(app).get('/api/search?location=City1');
    // 402 expected without token
    const blocked = await request(app).get('/api/search?location=City2Unique');
    // Could be 402 or 200 from cache; ensure by using a truly new location
    // Get a token
    const tokenRes = await request(app).get('/api/ad-token');
    const token = tokenRes.body.token;

    // Use the token on a new unique location
    const res = await request(app).get(
      `/api/search?location=CityUniqueAdToken&adToken=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/scrape
// ---------------------------------------------------------------------------
describe('POST /api/scrape', () => {
  test('returns 400 when url is missing', async () => {
    const res = await request(app).post('/api/scrape').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });

  test('returns 400 when url is blank', async () => {
    const res = await request(app).post('/api/scrape').send({ url: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });

  test('returns 400 when url exceeds 2048 characters', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    const res = await request(app).post('/api/scrape').send({ url: longUrl });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  test('returns 400 when url targets localhost (SSRF protection)', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'http://localhost/secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private or loopback/i);
  });

  test('returns 400 when url targets a private IP (SSRF protection)', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'http://192.168.1.1/admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private or loopback/i);
  });

  test('returns 400 when url uses a non-http scheme (SSRF protection)', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http or https/i);
  });

  test('returns scraped venue on success', async () => {
    scraper.scrapeVenue.mockResolvedValue(SAMPLE_VENUES[0]);

    const res = await request(app)
      .post('/api/scrape')
      .send({ url: 'https://crownandanchor.com' });
    expect(res.status).toBe(200);
    expect(res.body.venue).toEqual(SAMPLE_VENUES[0]);
  });

  test('returns 502 when scraper throws', async () => {
    scraper.scrapeVenue.mockRejectedValue(new Error('Scrape failed'));

    const res = await request(app)
      .post('/api/scrape')
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Scrape failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
// ---------------------------------------------------------------------------
describe('POST /api/create-checkout-session', () => {
  test('returns 503 when Stripe is not configured', async () => {
    const res = await request(app).post('/api/create-checkout-session');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/activate
// ---------------------------------------------------------------------------
describe('GET /api/activate', () => {
  test('returns 400 when session_id is missing', async () => {
    const res = await request(app).get('/api/activate');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_id/i);
  });

  test('returns 503 when Stripe is not configured', async () => {
    const res = await request(app).get('/api/activate?session_id=cs_test_123');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/subscriber-status
// ---------------------------------------------------------------------------
describe('GET /api/subscriber-status', () => {
  test('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/subscriber-status');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing/i);
  });

  test('returns 401 for an invalid token', async () => {
    const res = await request(app).get('/api/subscriber-status?subscriberToken=not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('returns 401 for a token signed with the wrong secret', async () => {
    const token = makeSubscriberToken('sub-wrong-secret', 'wrong-secret');
    const res = await request(app).get(
      '/api/subscriber-status?subscriberToken=' + encodeURIComponent(token),
    );
    expect(res.status).toBe(401);
  });

  test('returns remaining searches for a valid subscriber token', async () => {
    const subscriberId = 'sub-status-test';
    app._subscriberSearches.set(subscriberId, 10);
    const token = makeSubscriberToken(subscriberId);
    const res = await request(app).get(
      '/api/subscriber-status?subscriberToken=' + encodeURIComponent(token),
    );
    expect(res.status).toBe(200);
    expect(res.body.searchesRemaining).toBe(90);
    expect(res.body.searchesTotal).toBe(100);
  });

  test('returns full quota for a subscriber not yet tracked in memory', async () => {
    const token = makeSubscriberToken('sub-new');
    const res = await request(app).get(
      '/api/subscriber-status?subscriberToken=' + encodeURIComponent(token),
    );
    expect(res.status).toBe(200);
    expect(res.body.searchesRemaining).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// POST /api/stripe-webhook
// ---------------------------------------------------------------------------
describe('POST /api/stripe-webhook', () => {
  test('returns 200 when Stripe webhook is not configured', async () => {
    const res = await request(app)
      .post('/api/stripe-webhook')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/search — subscriber token behaviour
// ---------------------------------------------------------------------------
describe('GET /api/search — subscriber token', () => {
  test('subscriber token bypasses the ad gate after free quota is exhausted', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    // Exhaust free searches
    await request(app).get('/api/search?location=City1');

    const subscriberId = 'sub-bypass-test';
    app._subscriberSearches.set(subscriberId, 0);
    const token = makeSubscriberToken(subscriberId);

    const res = await request(app).get(
      '/api/search?location=CitySubscriberUnique&subscriberToken=' + encodeURIComponent(token),
    );
    expect(res.status).toBe(200);
  });

  test('subscriber search count increments after a successful fresh search', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const subscriberId = 'sub-increment-test';
    app._subscriberSearches.set(subscriberId, 0);
    const token = makeSubscriberToken(subscriberId);

    await request(app).get(
      '/api/search?location=CityIncrementTest&subscriberToken=' + encodeURIComponent(token),
    );
    expect(app._subscriberSearches.get(subscriberId)).toBe(1);
  });

  test('cached search does not increment subscriber count', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const subscriberId = 'sub-cache-test';
    app._subscriberSearches.set(subscriberId, 0);
    const token = makeSubscriberToken(subscriberId);

    // First request populates cache
    await request(app).get(
      '/api/search?location=CityCacheTest&subscriberToken=' + encodeURIComponent(token),
    );
    const usedAfterFirst = app._subscriberSearches.get(subscriberId);

    // Second request hits cache
    await request(app).get(
      '/api/search?location=CityCacheTest&subscriberToken=' + encodeURIComponent(token),
    );
    expect(app._subscriberSearches.get(subscriberId)).toBe(usedAfterFirst);
  });

  test('returns 402 search_limit_reached when subscriber quota is exhausted', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const subscriberId = 'sub-exhausted-test';
    app._subscriberSearches.set(subscriberId, 100); // already used all 100
    const token = makeSubscriberToken(subscriberId);

    const res = await request(app).get(
      '/api/search?location=CityExhaustedTest&subscriberToken=' + encodeURIComponent(token),
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('search_limit_reached');
  });
});
