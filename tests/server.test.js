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
  test('returns 400 when location is missing', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  test('returns 400 when location is blank', async () => {
    const res = await request(app).get('/api/search?location=   ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  test('returns venues from scraper on cache miss', async () => {
    scraper.searchVenues.mockResolvedValue(SAMPLE_VENUES);

    const res = await request(app).get('/api/search?location=Brooklyn,NY');
    expect(res.status).toBe(200);
    expect(res.body.fromCache).toBe(false);
    expect(res.body.venues).toEqual(SAMPLE_VENUES);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
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
    expect(scraper.searchVenues).toHaveBeenCalledWith('Brooklyn,NY', { limit: 5 });
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
