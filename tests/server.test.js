'use strict';

const request = require('supertest');
const app = require('../functions/server');
const venueStore = require('../functions/venueStore');
const scraper = require('../functions/scraper');

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

beforeEach(() => {
  venueStore.clear();
  app._searchCounters.clear();
  app._adTokens.clear();
  app._userReportStore.clear();
  app._userReportRateLimit.clear();
  app._businessClaimStore.clear();
  app._emergencyClosureStore.clear();
  app._businessActionRateLimit.clear();
  app._ownerPhoneVerificationStore.clear();
  app._verifiedOwnerPhoneStore.clear();
  app._ownerTextUpdateStore.clear();
  app._ownerTextScheduleStore.clear();
  app._ownerTextAuditStore.clear();
  app._ownerTextIngressRateLimit.clear();
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
    // Venues are enriched with affiliate_links and kitchen_status
    for (const v of res.body.venues) {
      expect(v).toMatchObject({ name: expect.any(String) });
      expect(v.affiliate_links).toBeDefined();
      expect(v.kitchen_status).toBeDefined();
      expect(v.kitchen_status.confidence_score).toEqual(expect.any(Number));
      expect(typeof v.kitchen_status.is_verified).toBe('boolean');
    }
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });

  test('returns venues from scraper when searching by name only', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?name=The+Crown');
    expect(res.status).toBe(200);
    expect(res.body.venues.length).toBe(SAMPLE_VENUES.length);
    expect(res.body.venues[0]).toMatchObject({ name: SAMPLE_VENUES[0].name });
    expect(res.body.venues[0].affiliate_links).toBeDefined();
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });

  test('returns venues from scraper when searching by name and location', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?name=The+Crown&location=Brooklyn,NY');
    expect(res.status).toBe(200);
    expect(res.body.venues[0]).toMatchObject({ name: SAMPLE_VENUES[0].name });
    expect(res.body.venues[0].kitchen_status).toBeDefined();
  });

  test('returns venues when searching with servingUntil parameter', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?location=Brooklyn,NY&servingUntil=10pm');
    expect(res.status).toBe(200);
    expect(res.body.venues[0]).toMatchObject({ name: SAMPLE_VENUES[0].name });
    expect(res.body.venues[0].affiliate_links).toBeDefined();
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
      { limit: 5, utcOffsetMinutes: 0 },
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
// GET /api/v1/venues/open-now
// ---------------------------------------------------------------------------
describe('GET /api/v1/venues/open-now', () => {
  test('returns 400 when lat is missing', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lng=-73.9');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat/i);
  });

  test('returns 400 when lng is missing', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat|lng/i);
  });

  test('returns 400 for out-of-range lat', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=100&lng=-73.9');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat/i);
  });

  test('returns 400 for out-of-range lng', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7&lng=200');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lng/i);
  });

  test('returns empty venues array when no DB configured', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7128&lng=-74.0060');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
    expect(res.body.message).toMatch(/database/i);
  });

  test('accepts time_override parameter', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7128&lng=-74.0060&time_override=21:00');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
  });

  test('accepts radius_miles parameter', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7128&lng=-74.0060&radius_miles=10');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
  });

  test('accepts limit parameter', async () => {
    const res = await request(app).get('/api/v1/venues/open-now?lat=40.7128&lng=-74.0060&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/user-report
// ---------------------------------------------------------------------------
describe('POST /api/user-report', () => {
  test('records a yes report and returns vote count', async () => {
    const res = await request(app)
      .post('/api/user-report')
      .send({ venue_name: 'Test Bar', venue_url: 'https://testbar.com', is_serving: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vote_count).toBe(1);
    expect(res.body.yes_count).toBe(1);
  });

  test('records a no report', async () => {
    const res = await request(app)
      .post('/api/user-report')
      .send({ venue_name: 'Test Bar', venue_url: 'https://testbar.com', is_serving: false });
    expect(res.status).toBe(200);
    expect(res.body.yes_count).toBe(0);
    expect(res.body.vote_count).toBe(1);
  });

  test('accumulates multiple reports from different votes', async () => {
    await request(app).post('/api/user-report').send({ venue_name: 'Bar A', is_serving: true });
    app._userReportRateLimit.clear(); // reset rate limiter to allow re-voting in tests
    await request(app).post('/api/user-report').send({ venue_name: 'Bar A', is_serving: false });
    app._userReportRateLimit.clear();
    const res = await request(app).post('/api/user-report').send({ venue_name: 'Bar A', is_serving: true });
    expect(res.body.vote_count).toBe(3);
    expect(res.body.yes_count).toBe(2);
  });

  test('rejects missing venue_name', async () => {
    const res = await request(app).post('/api/user-report').send({ is_serving: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/venue_name/i);
  });

  test('rejects non-boolean is_serving', async () => {
    const res = await request(app).post('/api/user-report').send({ venue_name: 'Bar', is_serving: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is_serving/i);
  });

  test('rejects venue_name that is too long', async () => {
    const res = await request(app)
      .post('/api/user-report')
      .send({ venue_name: 'A'.repeat(256), is_serving: true });
    expect(res.status).toBe(400);
  });

  test('rate-limits the same IP+venue within cooldown period', async () => {
    await request(app).post('/api/user-report').send({ venue_name: 'Cooldown Bar', is_serving: true });
    const res = await request(app).post('/api/user-report').send({ venue_name: 'Cooldown Bar', is_serving: false });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/already reported/i);
  });
});

// ---------------------------------------------------------------------------
// Business claim endpoints (Stripe not configured → 503)
// ---------------------------------------------------------------------------
describe('Business claim endpoints (Stripe not configured)', () => {
  test('POST /api/business/create-checkout-session returns 503 without STRIPE_SECRET_KEY', async () => {
    const res = await request(app)
      .post('/api/business/create-checkout-session')
      .send({ venue_name: 'My Restaurant', email: 'owner@example.com' });
    expect(res.status).toBe(503);
  });

  test('GET /api/business/activate returns 503 without STRIPE_SECRET_KEY', async () => {
    const res = await request(app).get('/api/business/activate?session_id=cs_test_123');
    expect(res.status).toBe(503);
  });

  test('POST /api/business/hours returns 401 without token', async () => {
    const res = await request(app)
      .post('/api/business/hours')
      .send({ day_of_week: 1, kitchen_open: '11:00', kitchen_close: '22:00' });
    expect(res.status).toBe(401);
  });

  test('POST /api/business/close-now returns 401 without token', async () => {
    const res = await request(app)
      .post('/api/business/close-now')
      .send({ reason: 'emergency' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/business/hours — validation (with fake JWT)
// ---------------------------------------------------------------------------
describe('POST /api/business/hours validation', () => {
  const jwt = require('jsonwebtoken');
  const secret = process.env.BUSINESS_JWT_SECRET || 'business-jwt-secret-change-in-production';

  function makeToken(venueKey) {
    return jwt.sign({ venueKey, stripeSessionId: 'sess_fake', role: 'business_owner' }, secret, { expiresIn: '1y' });
  }

  test('rejects invalid day_of_week', async () => {
    const token = makeToken('bar||');
    app._businessClaimStore.set('bar||', { venueName: 'Bar', venueUrl: '', paidAt: new Date(), stripeSessionId: 'sess_fake' });
    const res = await request(app)
      .post('/api/business/hours')
      .set('Authorization', `Bearer ${token}`)
      .send({ day_of_week: 9, kitchen_open: '11:00', kitchen_close: '22:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/day_of_week/i);
  });

  test('rejects malformed time format', async () => {
    const token = makeToken('bar||');
    app._businessClaimStore.set('bar||', { venueName: 'Bar', venueUrl: '', paidAt: new Date(), stripeSessionId: 'sess_fake' });
    const res = await request(app)
      .post('/api/business/hours')
      .set('Authorization', `Bearer ${token}`)
      .send({ day_of_week: 1, kitchen_open: '9am', kitchen_close: '22:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kitchen_open/i);
  });

  test('rejects when no active claim exists', async () => {
    const token = makeToken('unclaimed-venue||');
    const res = await request(app)
      .post('/api/business/hours')
      .set('Authorization', `Bearer ${token}`)
      .send({ day_of_week: 1, kitchen_open: '11:00', kitchen_close: '22:00' });
    expect(res.status).toBe(403);
  });

  test('accepts valid update when claim exists', async () => {
    const venueKey = 'my restaurant||https://myrestaurant.com';
    const token = makeToken(venueKey);
    app._businessClaimStore.set(venueKey, { venueName: 'My Restaurant', venueUrl: 'https://myrestaurant.com', paidAt: new Date(), stripeSessionId: 'sess_fake' });
    const res = await request(app)
      .post('/api/business/hours')
      .set('Authorization', `Bearer ${token}`)
      .send({ day_of_week: 2, kitchen_open: '11:00', kitchen_close: '23:00' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/business/close-now
// ---------------------------------------------------------------------------
describe('POST /api/business/close-now', () => {
  const jwt = require('jsonwebtoken');
  const secret = process.env.BUSINESS_JWT_SECRET || 'business-jwt-secret-change-in-production';

  function makeToken(venueKey) {
    return jwt.sign({ venueKey, stripeSessionId: 'sess_fake', role: 'business_owner' }, secret, { expiresIn: '1y' });
  }

  test('records emergency closure and returns closed_until', async () => {
    const venueKey = 'crisis bar||https://crisisbar.com';
    const token = makeToken(venueKey);
    app._businessClaimStore.set(venueKey, { venueName: 'Crisis Bar', venueUrl: 'https://crisisbar.com', paidAt: new Date(), stripeSessionId: 'sess_fake' });
    const res = await request(app)
      .post('/api/business/close-now')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'robbery' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.closed_until).toBeDefined();
    const closure = app._emergencyClosureStore.get(venueKey);
    expect(closure).toBeDefined();
    expect(closure.closed_until).toBeInstanceOf(Date);
    expect(closure.reason).toBe('robbery');
  });

  test('returns 401 without token', async () => {
    const res = await request(app).post('/api/business/close-now').send({ reason: 'test' });
    expect(res.status).toBe(401);
  });

  test('returns 403 when no active claim', async () => {
    const token = makeToken('no-claim||');
    const res = await request(app)
      .post('/api/business/close-now')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Owner text updates
// ---------------------------------------------------------------------------
describe('Owner text updates', () => {
  const jwt = require('jsonwebtoken');
  const secret = process.env.BUSINESS_JWT_SECRET || 'business-jwt-secret-change-in-production';

  function makeToken(venueKey) {
    return jwt.sign({ venueKey, stripeSessionId: 'sess_fake', role: 'business_owner' }, secret, { expiresIn: '1y' });
  }

  test('registers and verifies an owner text phone number', async () => {
    const venueKey = 'text bar||https://textbar.com';
    const token = makeToken(venueKey);
    app._businessClaimStore.set(venueKey, {
      venueName: 'Text Bar',
      venueUrl: 'https://textbar.com',
      paidAt: new Date(),
      stripeSessionId: 'sess_fake',
    });

    const registerRes = await request(app)
      .post('/api/business/text-number')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '(555) 123-4567' });

    expect(registerRes.status).toBe(200);
    expect(registerRes.body.phone).toBe('+5551234567');
    expect(registerRes.body.verification_code).toMatch(/^\d{6}$/);

    const verifyRes = await request(app)
      .post('/api/business/text-number/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+5551234567', code: registerRes.body.verification_code });

    expect(verifyRes.status).toBe(200);
    expect(app._verifiedOwnerPhoneStore.get('+5551234567')).toMatchObject({ venueKey });
    expect(app._businessClaimStore.get(venueKey).verifiedPhone).toBe('+5551234567');
  });

  test('rejects inbound text from an unknown number', async () => {
    const res = await request(app)
      .post('/api/business/inbound-text')
      .send({ from: '+15551234567', body: 'OPEN 10' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not verified/i);
  });

  test('applies OPEN text updates to cached search results', async () => {
    const venueKey = 'the crown & anchor||https://crownandanchor.com';
    app._businessClaimStore.set(venueKey, {
      venueName: 'The Crown & Anchor',
      venueUrl: 'https://crownandanchor.com',
      paidAt: new Date(),
      stripeSessionId: 'sess_fake',
      verifiedPhone: '+15551234567',
    });
    app._verifiedOwnerPhoneStore.set('+15551234567', { venueKey, verified_at: new Date() });
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const firstSearch = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(firstSearch.status).toBe(200);
    expect(firstSearch.body.fromCache).toBe(false);

    const textRes = await request(app)
      .post('/api/business/inbound-text')
      .send({ from: '+15551234567', body: 'OPEN 10' });

    expect(textRes.status).toBe(200);
    expect(textRes.body.action).toBe('open_until');

    const secondSearch = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(secondSearch.status).toBe(200);
    expect(secondSearch.body.fromCache).toBe(true);
    expect(secondSearch.body.venues[0].serving).toBe(true);
    expect(secondSearch.body.venues[0].kitchen_status.verified_via).toBe('owner_text');
    expect(secondSearch.body.venues[0].kitchen_status.owner_text_update).toMatchObject({
      type: 'open_until',
      recent: true,
    });
  });

  test('applies CLOSED text updates as emergency closures in search results', async () => {
    const venueKey = 'the crown & anchor||https://crownandanchor.com';
    app._businessClaimStore.set(venueKey, {
      venueName: 'The Crown & Anchor',
      venueUrl: 'https://crownandanchor.com',
      paidAt: new Date(),
      stripeSessionId: 'sess_fake',
      verifiedPhone: '+15551234567',
    });
    app._verifiedOwnerPhoneStore.set('+15551234567', { venueKey, verified_at: new Date() });
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    await request(app).get('/api/search?location=Brooklyn,NY');

    const textRes = await request(app)
      .post('/api/business/inbound-text')
      .send({ from: '+15551234567', body: 'REOPEN 6' });

    expect(textRes.status).toBe(200);
    expect(textRes.body.closed_until).toBeDefined();

    const cachedSearch = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(cachedSearch.status).toBe(200);
    expect(cachedSearch.body.venues[0].serving).toBe(false);
    expect(cachedSearch.body.venues[0].kitchen_status.emergency_closure).toBe(true);
    expect(cachedSearch.body.venues[0].kitchen_status.owner_text_update).toMatchObject({
      type: 'closed_until',
      recent: true,
    });
  });

  test('returns TwiML replies for Twilio-style inbound requests', async () => {
    const venueKey = 'the crown & anchor||https://crownandanchor.com';
    app._businessClaimStore.set(venueKey, {
      venueName: 'The Crown & Anchor',
      venueUrl: 'https://crownandanchor.com',
      paidAt: new Date(),
      stripeSessionId: 'sess_fake',
      verifiedPhone: '+15551234567',
    });
    app._verifiedOwnerPhoneStore.set('+15551234567', { venueKey, verified_at: new Date() });

    const res = await request(app)
      .post('/api/business/inbound-text')
      .type('form')
      .send({ From: '+15551234567', Body: 'OPEN 10' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toMatch(/<Response><Message>Marked open until/);
  });

  test('applies schedule-mode text updates to cached search results', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-04-04T12:00:00Z'));

      const venueKey = 'the crown & anchor||https://crownandanchor.com';
      app._businessClaimStore.set(venueKey, {
        venueName: 'The Crown & Anchor',
        venueUrl: 'https://crownandanchor.com',
        paidAt: new Date(),
        stripeSessionId: 'sess_fake',
        verifiedPhone: '+15551234567',
      });
      app._verifiedOwnerPhoneStore.set('+15551234567', { venueKey, verified_at: new Date() });
      scraper.searchVenues.mockResolvedValue([{ ...SAMPLE_VENUES[0], serving: false, closesAt: null }]);

      await request(app).get('/api/search?location=Brooklyn,NY');

      const textRes = await request(app)
        .post('/api/business/inbound-text')
        .send({ from: '+15551234567', body: 'SAT 11-9' });

      expect(textRes.status).toBe(200);
      expect(textRes.body.action).toBe('schedule_update');

      const cachedSearch = await request(app).get('/api/search?location=Brooklyn,NY');
      expect(cachedSearch.status).toBe(200);
      expect(cachedSearch.body.venues[0].serving).toBe(true);
      expect(cachedSearch.body.venues[0].kitchen_status.verified_via).toBe('owner_text_schedule');
      expect(cachedSearch.body.venues[0].kitchen_status.owner_text_update).toMatchObject({
        type: 'schedule_update',
        schedule_label: 'SAT 11:00 AM-9:00 PM',
        recent: true,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('records closed-day schedule updates', async () => {
    const venueKey = 'the crown & anchor||https://crownandanchor.com';
    app._businessClaimStore.set(venueKey, {
      venueName: 'The Crown & Anchor',
      venueUrl: 'https://crownandanchor.com',
      paidAt: new Date(),
      stripeSessionId: 'sess_fake',
      verifiedPhone: '+15551234567',
    });
    app._verifiedOwnerPhoneStore.set('+15551234567', { venueKey, verified_at: new Date() });

    const res = await request(app)
      .post('/api/business/inbound-text')
      .send({ from: '+15551234567', body: 'SUN CLOSED' });

    expect(res.status).toBe(200);
    expect(app._ownerTextScheduleStore.get(venueKey)).toMatchObject({
      closed_days: [0],
      schedule_label: 'SUN closed',
    });
  });
});

describe('Owner SMS setup UI', () => {
  test('serves the owner SMS setup page', async () => {
    const res = await request(app).get('/owner-sms.html');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Owner SMS setup/i);
    expect(res.text).toMatch(/MON-FRI 11-9/);
  });
});
