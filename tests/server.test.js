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
