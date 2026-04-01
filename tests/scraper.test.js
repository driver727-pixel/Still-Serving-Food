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
});

// ---------------------------------------------------------------------------
// searchVenues — API key validation and Firecrawl error paths
// ---------------------------------------------------------------------------
describe('searchVenues', () => {
  const ORIG_ENV = process.env.FIRECRAWL_API_KEY;

  afterEach(() => {
    process.env.FIRECRAWL_API_KEY = ORIG_ENV;
  });

  test('throws when FIRECRAWL_API_KEY is not set', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(searchVenues('Brooklyn, NY')).rejects.toThrow('FIRECRAWL_API_KEY is not set');
  });

  test('accepts apiKey passed via options (overrides env)', async () => {
    // Pass a dummy key; the call will fail at the network level, not at key-check
    delete process.env.FIRECRAWL_API_KEY;
    await expect(
      searchVenues('Brooklyn, NY', { apiKey: 'fc-dummy' }),
    ).rejects.toThrow(/Firecrawl search failed/);
  });

  test('returns empty array when Firecrawl returns no data array', async () => {
    const FirecrawlApp = require('@mendable/firecrawl-js').default;

    process.env.FIRECRAWL_API_KEY = 'fc-dummy';
    const origSearch = FirecrawlApp.prototype.search;
    FirecrawlApp.prototype.search = jest.fn().mockResolvedValue({ data: null });

    const venues = await searchVenues('Test City');
    expect(venues).toEqual([]);

    FirecrawlApp.prototype.search = origSearch;
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
    const origScrape = FirecrawlApp.prototype.scrapeUrl;
    FirecrawlApp.prototype.scrapeUrl = jest.fn().mockRejectedValue(new Error('timeout'));

    await expect(scrapeVenue('https://example.com')).rejects.toThrow(
      /Firecrawl scrape failed for https:\/\/example\.com/,
    );

    FirecrawlApp.prototype.scrapeUrl = origScrape;
  });
});
