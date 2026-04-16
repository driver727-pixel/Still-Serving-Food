'use strict';

/**
 * e2e.test.js
 *
 * End-to-end integration tests that exercise the complete pipeline:
 *   raw scraped text → parseHours → isCurrentlyServing → buildVenue → server API
 *
 * No external network calls are made; the Firecrawl client is mocked where
 * required by the server.
 */

const request = require('supertest');
const app = require('../functions/server');
const venueStore = require('../functions/venueStore');

// Scraper is mocked for the server API tests at the bottom of this file.
// Real implementations are accessed via jest.requireActual where needed.
jest.mock('../functions/scraper');
const scraper = require('../functions/scraper');
const { buildVenue } = jest.requireActual('../functions/scraper');

// Mock osmClient so the legacy search pipeline never makes real Overpass API
// calls during tests (which would return real venues and break count assertions).
jest.mock('../functions/osmClient', () => ({
  searchOsmVenues: jest.fn().mockResolvedValue([]),
  enrichVenuesWithOsmData: jest.fn((firecrawlVenues) => firecrawlVenues),
  buildVenuesFromOsmData: jest.fn().mockReturnValue([]),
}));

const { parseHours, isCurrentlyServing, formatTime } = require('../functions/hoursParser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDate(dayOfWeek, hours, minutes = 0) {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + dayOfWeek);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Full pipeline: realistic venue text → parsed hours → serving status
// ---------------------------------------------------------------------------
describe('Full pipeline: text → hours → serving status', () => {
  const pubMarkdown = `
    The Crown & Anchor — Food Menu
    Kitchen hours:
    Monday to Friday 12:00 pm - 9:00 pm
    Saturday 12pm - 10pm
    Sunday 12pm - 8pm
  `;

  let blocks;

  beforeAll(() => {
    blocks = parseHours(pubMarkdown);
  });

  test('parses 7 hour blocks (5 weekdays + Sat + Sun)', () => {
    expect(blocks.length).toBe(7);
  });

  test('all blocks are flagged as inFoodSection', () => {
    expect(blocks.every((b) => b.inFoodSection)).toBe(true);
  });

  test('Monday block has correct open/close times', () => {
    const mon = blocks.find((b) => b.day === 1);
    expect(mon).toBeDefined();
    expect(mon.open).toBe(12 * 60);
    expect(mon.close).toBe(21 * 60);
  });

  test('returns serving=true on Monday at 2pm', () => {
    const { serving } = isCurrentlyServing(blocks, makeDate(1, 14));
    expect(serving).toBe(true);
  });

  test('returns serving=false on Monday at 11pm, with no opensAt (past last close)', () => {
    const result = isCurrentlyServing(blocks, makeDate(1, 23));
    expect(result.serving).toBe(false);
    expect(result.opensAt).toBeNull();
  });

  test('returns serving=false on Monday at 10am, with correct opensAt', () => {
    const result = isCurrentlyServing(blocks, makeDate(1, 10));
    expect(result.serving).toBe(false);
    expect(result.opensAt).toBe(12 * 60);
  });

  test('Saturday closes at 10pm, formatTime produces "10:00 PM"', () => {
    const sat = blocks.find((b) => b.day === 6);
    expect(sat).toBeDefined();
    expect(formatTime(sat.close)).toBe('10:00 PM');
  });
});

// ---------------------------------------------------------------------------
// Cross-midnight pipeline
// ---------------------------------------------------------------------------
describe('Cross-midnight pipeline: late-night food service', () => {
  const lateBarMarkdown = `
    Grill hours:
    Friday 6pm-2am
    Saturday 6pm-2am
  `;

  let blocks;

  beforeAll(() => {
    blocks = parseHours(lateBarMarkdown);
  });

  test('parses 2 blocks (Fri + Sat)', () => {
    expect(blocks.length).toBe(2);
  });

  test('Friday 11pm → serving=true', () => {
    const result = isCurrentlyServing(blocks, makeDate(5, 23));
    expect(result.serving).toBe(true);
  });

  test('Saturday 1am → serving=true (wrap-around from Friday block)', () => {
    const result = isCurrentlyServing(blocks, makeDate(6, 1));
    expect(result.serving).toBe(true);
  });

  test('Saturday 3am → serving=false (past Friday close, before Sat open)', () => {
    const result = isCurrentlyServing(blocks, makeDate(6, 3));
    expect(result.serving).toBe(false);
  });

  test('Saturday 11pm → serving=true (Saturday block)', () => {
    const result = isCurrentlyServing(blocks, makeDate(6, 23));
    expect(result.serving).toBe(true);
  });

  test('Sunday 1am → serving=true (wrap-around from Saturday block)', () => {
    const result = isCurrentlyServing(blocks, makeDate(0, 1));
    expect(result.serving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildVenue end-to-end (uses jest.requireActual to get the real function)
// ---------------------------------------------------------------------------
describe('buildVenue end-to-end', () => {
  test('produces a complete venue object from realistic markdown', () => {
    const venue = buildVenue({
      url: 'https://thecrownandanchor.com',
      metadata: {
        title: 'The Crown & Anchor | Bar & Kitchen',
        description: 'Classic British pub with a full kitchen',
      },
      markdown: 'Kitchen hours:\nMon-Fri 12pm-9pm\nSat 12pm-10pm',
    });

    expect(venue.name).toBe('The Crown & Anchor');
    expect(venue.description).toBe('Classic British pub with a full kitchen');
    expect(venue.url).toBe('https://thecrownandanchor.com');
    expect(venue.hourBlocks.length).toBeGreaterThan(0);
    expect(typeof venue.serving).toBe('boolean');
    expect(venue.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('opensAt and closesAt are null when no hours are found', () => {
    const venue = buildVenue({
      url: 'https://example.com',
      metadata: { title: 'Test Bar' },
      markdown: '',
    });
    expect(venue.opensAt).toBeNull();
    expect(venue.closesAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server API end-to-end (scraper mocked)
// ---------------------------------------------------------------------------
describe('Server API end-to-end', () => {
  const REALISTIC_VENUE = {
    name: 'The Crown & Anchor',
    url: 'https://crownandanchor.com',
    description: 'Classic British pub with full kitchen',
    serving: true,
    opensAt: null,
    closesAt: '9:00 PM',
    hourBlocks: [
      { day: 1, open: 12 * 60, close: 21 * 60, label: 'monday', inFoodSection: true },
    ],
    scrapedAt: new Date().toISOString(),
  };

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

  test('full search flow: miss → scrape → cache hit → same data', async () => {
    scraper.searchVenues.mockResolvedValue([REALISTIC_VENUE]);

    // First request hits scraper
    const res1 = await request(app).get('/api/search?location=London,UK&limit=1');
    expect(res1.status).toBe(200);
    expect(res1.body.fromCache).toBe(false);
    expect(res1.body.venues).toHaveLength(1);
    expect(res1.body.venues[0].name).toBe('The Crown & Anchor');

    // Second request serves from cache — scraper still called only once
    const res2 = await request(app).get('/api/search?location=London,UK&limit=1');
    expect(res2.status).toBe(200);
    expect(res2.body.fromCache).toBe(true);
    expect(res2.body.venues[0]).toEqual(res1.body.venues[0]);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });

  test('scrape endpoint returns a full venue object', async () => {
    scraper.scrapeVenue.mockResolvedValue(REALISTIC_VENUE);

    const res = await request(app)
      .post('/api/scrape')
      .send({ url: 'https://crownandanchor.com' });

    expect(res.status).toBe(200);
    expect(res.body.venue.name).toBe('The Crown & Anchor');
    expect(res.body.venue.hourBlocks).toHaveLength(1);
    expect(res.body.venue.serving).toBe(true);
    expect(res.body.venue.closesAt).toBe('9:00 PM');
  });

  test('search result includes venue with correct hourBlock structure', async () => {
    scraper.searchVenues.mockResolvedValue([REALISTIC_VENUE]);

    const res = await request(app).get('/api/search?location=London,UK');
    const venue = res.body.venues[0];

    expect(venue).toMatchObject({
      name: expect.any(String),
      url: expect.any(String),
      serving: expect.any(Boolean),
      hourBlocks: expect.any(Array),
      scrapedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(venue.hourBlocks[0]).toMatchObject({
      day: expect.any(Number),
      open: expect.any(Number),
      close: expect.any(Number),
      label: expect.any(String),
    });
  });

  test('cache is location-case-insensitive across requests', async () => {
    scraper.searchVenues.mockResolvedValue([REALISTIC_VENUE]);

    await request(app).get('/api/search?location=London,UK');
    const res = await request(app).get('/api/search?location=london,uk');

    expect(res.body.fromCache).toBe(true);
    expect(scraper.searchVenues).toHaveBeenCalledTimes(1);
  });
});
