'use strict';

const { buildVenue, searchVenues, scrapeVenue } = require('../functions/scraper');

describe('buildVenue', () => {
  test('derives name from metadata title', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'The Fox & Hound | Bar & Grill' },
      markdown: '',
    };
    const venue = buildVenue(raw);
    expect(venue.name).toBe('The Fox & Hound');
  });

  test('falls back to hostname when no title', () => {
    const raw = {
      url: 'https://www.thefoxandhound.com',
      markdown: '',
    };
    const venue = buildVenue(raw);
    expect(venue.name).toBe('thefoxandhound.com');
  });

  test('parses food hours from markdown content', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Test Pub' },
      markdown: 'Kitchen hours:\nMon-Fri 12pm-9pm\nSat 12pm-10pm',
    };
    const venue = buildVenue(raw);
    expect(venue.hourBlocks.length).toBeGreaterThan(0);
    expect(typeof venue.serving).toBe('boolean');
  });

  test('returns unknown hours when markdown is empty', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Silent Bar' },
      markdown: '',
    };
    const venue = buildVenue(raw);
    expect(venue.hourBlocks).toEqual([]);
    expect(venue.serving).toBe(false);
  });

  test('includes scrapedAt ISO timestamp', () => {
    const raw = { url: 'https://example.com', markdown: '' };
    const venue = buildVenue(raw);
    expect(venue.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('uses "Unknown Venue" when no title and no url', () => {
    const venue = buildVenue({ markdown: '' });
    expect(venue.name).toBe('Unknown Venue');
  });

  test('uses description from metadata', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Test', description: 'A great pub' },
      markdown: '',
    };
    const venue = buildVenue(raw);
    expect(venue.description).toBe('A great pub');
  });

  test('sets is24Hours to false by default', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Regular Pub' },
      markdown: 'Mon-Fri 12pm-9pm',
    };
    const venue = buildVenue(raw);
    expect(venue.is24Hours).toBe(false);
  });

  test('sets is24Hours to true when content says "open 24 hours"', () => {
    const raw = {
      url: 'https://dennys.com',
      metadata: { title: "Denny's" },
      markdown: "We're open 24 hours a day, 7 days a week.",
    };
    const venue = buildVenue(raw);
    expect(venue.is24Hours).toBe(true);
    expect(venue.serving).toBe(true);
  });

  test('sets is24Hours to true when content contains "24/7"', () => {
    const raw = {
      url: 'https://mcdonalds.com',
      metadata: { title: "McDonald's" },
      markdown: 'Hot food available 24/7 at this location.',
    };
    const venue = buildVenue(raw);
    expect(venue.is24Hours).toBe(true);
    expect(venue.serving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchVenues — API key validation and Firecrawl error paths
// ---------------------------------------------------------------------------
describe('searchVenues', () => {
  const ORIG_ENV = process.env.FIRECRAWL_API_KEY;

  afterEach(() => {
    process.env.FIRECRAWL_API_KEY = ORIG_ENV;
  });

  test('throws when FIRECRAWL_API_KEY is not set (string form)', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(searchVenues('Brooklyn, NY')).rejects.toThrow('FIRECRAWL_API_KEY is not set');
  });

  test('throws when FIRECRAWL_API_KEY is not set (object form)', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(searchVenues({ location: 'Brooklyn, NY' })).rejects.toThrow('FIRECRAWL_API_KEY is not set');
  });

  test('accepts apiKey passed via options (overrides env)', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(
      searchVenues('Brooklyn, NY', { apiKey: 'fc-dummy' }),
    ).rejects.toThrow(/Firecrawl search failed/);
  });

  test('accepts name param and builds correct query', async () => {
    const FirecrawlApp = require('@mendable/firecrawl-js').default;
    process.env.FIRECRAWL_API_KEY = 'fc-dummy';

    const mockSearch = jest.fn().mockResolvedValue({ web: [] });
    FirecrawlApp.prototype.search = mockSearch;

    await searchVenues({ name: 'The Crown', location: 'Brooklyn, NY' });
    const calledQuery = mockSearch.mock.calls[0][0];
    expect(calledQuery).toContain('"The Crown"');
    expect(calledQuery).toContain('"Brooklyn, NY"');

    delete FirecrawlApp.prototype.search;
  });

  test('accepts servingUntil param and includes it in query', async () => {
    const FirecrawlApp = require('@mendable/firecrawl-js').default;
    process.env.FIRECRAWL_API_KEY = 'fc-dummy';

    const mockSearch = jest.fn().mockResolvedValue({ web: [] });
    FirecrawlApp.prototype.search = mockSearch;

    await searchVenues({ location: 'Brooklyn, NY', servingUntil: '10pm' });
    const calledQuery = mockSearch.mock.calls[0][0];
    expect(calledQuery).toContain('serving until 10pm');

    delete FirecrawlApp.prototype.search;
  });

  test('returns empty array when Firecrawl returns no data array', async () => {
    const FirecrawlApp = require('@mendable/firecrawl-js').default;

    process.env.FIRECRAWL_API_KEY = 'fc-dummy';
    FirecrawlApp.prototype.search = jest.fn().mockResolvedValue({ web: null });

    const venues = await searchVenues('Test City');
    expect(venues).toEqual([]);

    delete FirecrawlApp.prototype.search;
  });
});

// ---------------------------------------------------------------------------
// scrapeVenue — API key validation
// ---------------------------------------------------------------------------
describe('scrapeVenue', () => {
  const ORIG_ENV = process.env.FIRECRAWL_API_KEY;

  afterEach(() => {
    process.env.FIRECRAWL_API_KEY = ORIG_ENV;
  });

  test('throws when FIRECRAWL_API_KEY is not set', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(scrapeVenue('https://example.com')).rejects.toThrow('FIRECRAWL_API_KEY is not set');
  });

  test('wraps Firecrawl errors with a descriptive message', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-dummy';
    const FirecrawlApp = require('@mendable/firecrawl-js').default;
    const origScrape = FirecrawlApp.prototype.scrape;
    FirecrawlApp.prototype.scrape = jest.fn().mockRejectedValue(new Error('timeout'));

    await expect(scrapeVenue('https://example.com')).rejects.toThrow(
      /Firecrawl scrape failed for https:\/\/example\.com/,
    );

    delete FirecrawlApp.prototype.scrape;
  });
});
