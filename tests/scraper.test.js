'use strict';

const { buildVenue, searchVenues, scrapeVenue, isVenueRelevant, buildQuery } = require('../functions/scraper');

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

  test('sets callForHours to true when content says "call for hours"', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Sunset Bar & Grill' },
      markdown: 'Please call for hours — we vary seasonally.',
    };
    const venue = buildVenue(raw);
    expect(venue.callForHours).toBe(true);
  });

  test('sets callForHours to true when content mentions "serving late"', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Night Owl Bar' },
      markdown: 'We specialize in serving late night meals until 4am.',
    };
    const venue = buildVenue(raw);
    expect(venue.callForHours).toBe(true);
  });

  test('sets callForHours to true when content says "open late"', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Late Night Eats' },
      markdown: 'We are open late on weekends.',
    };
    const venue = buildVenue(raw);
    expect(venue.callForHours).toBe(true);
  });

  test('sets callForHours to false for standard venues', () => {
    const raw = {
      url: 'https://example.com',
      metadata: { title: 'Regular Restaurant' },
      markdown: 'Kitchen hours: Mon-Fri 12pm-9pm',
    };
    const venue = buildVenue(raw);
    expect(venue.callForHours).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isVenueRelevant — filtering logic
// ---------------------------------------------------------------------------
describe('isVenueRelevant', () => {
  test('accepts a standard restaurant page', () => {
    const raw = {
      url: 'https://myrestaurant.com',
      metadata: { title: 'My Restaurant' },
      markdown: 'Kitchen hours: Mon-Fri 12pm-9pm',
    };
    expect(isVenueRelevant(raw)).toBe(true);
  });

  test('accepts a Yelp individual business listing', () => {
    const raw = {
      url: 'https://yelp.com/biz/my-restaurant',
      metadata: { title: 'My Restaurant - Yelp' },
      markdown: 'Kitchen hours...',
    };
    expect(isVenueRelevant(raw)).toBe(true);
  });

  test('rejects Instagram post URLs', () => {
    const raw = {
      url: 'https://www.instagram.com/p/ABC123/',
      metadata: { title: 'Photo post' },
      markdown: '',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects Twitter status URLs', () => {
    const raw = {
      url: 'https://twitter.com/foodtruck/status/123456',
      metadata: { title: 'Tweet' },
      markdown: '',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects Yelp search-result pages', () => {
    const raw = {
      url: 'https://yelp.com/search?find_desc=restaurants',
      metadata: { title: 'Restaurants near me - Yelp' },
      markdown: '',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects TripAdvisor restaurant list pages', () => {
    const raw = {
      url: 'https://tripadvisor.com/Restaurants-g60763-New_York.html',
      metadata: { title: 'Best Restaurants in New York - TripAdvisor' },
      markdown: '',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects listicle URLs containing /top-10/', () => {
    const raw = {
      url: 'https://eater.com/top-10-restaurants-nyc',
      metadata: { title: 'Top 10 Restaurants in NYC' },
      markdown: '',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects pages advertising private events', () => {
    const raw = {
      url: 'https://events.com/venue',
      metadata: { title: 'Event Venue' },
      markdown: 'Perfect for private events and private catering.',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('rejects bare hotel pages with no food-service language', () => {
    const raw = {
      url: 'https://marriott.com/hotel-downtown',
      metadata: { title: 'Marriott Hotel Downtown' },
      markdown: 'Luxury rooms and suites. Free Wi-Fi.',
    };
    expect(isVenueRelevant(raw)).toBe(false);
  });

  test('accepts hotel pages that mention a restaurant', () => {
    const raw = {
      url: 'https://hotel.com/dining',
      metadata: { title: 'The Capital Hotel Restaurant' },
      markdown: 'Fine dining at the hotel.',
    };
    expect(isVenueRelevant(raw)).toBe(true);
  });

  test('accepts hotel pages whose body mentions a kitchen / grill', () => {
    const raw = {
      url: 'https://hilton.com/hotel/dining',
      metadata: { title: 'Hilton Inn & Suites' },
      markdown: 'Our on-site grill is open daily from 7am to 10pm.',
    };
    expect(isVenueRelevant(raw)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildQuery — query construction
// ---------------------------------------------------------------------------
describe('buildQuery', () => {
  test('includes quoted name and location', () => {
    const q = buildQuery({ name: 'The Crown', location: 'Brooklyn, NY' });
    expect(q).toContain('"The Crown"');
    expect(q).toContain('"Brooklyn, NY"');
  });

  test('includes restaurant and food-truck venue types', () => {
    const q = buildQuery({ location: 'Brooklyn, NY' });
    expect(q).toMatch(/restaurant/i);
    expect(q).toMatch(/"food truck"/i);
    expect(q).toMatch(/\bdiner\b/i);
    expect(q).toMatch(/\bcafe\b/i);
    expect(q).toMatch(/\bbar\b/i);
    expect(q).toMatch(/\bgrill\b/i);
  });

  test('includes servingUntil phrase', () => {
    const q = buildQuery({ location: 'Brooklyn, NY', servingUntil: '10pm' });
    expect(q).toContain('serving until 10pm');
  });

  test('includes food-hours phrases', () => {
    const q = buildQuery({ location: 'Brooklyn, NY' });
    expect(q).toContain('"kitchen hours"');
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

  test('filters out irrelevant results (listicle + social post) from search', async () => {
    const FirecrawlApp = require('@mendable/firecrawl-js').default;
    process.env.FIRECRAWL_API_KEY = 'fc-dummy';

    FirecrawlApp.prototype.search = jest.fn().mockResolvedValue({
      web: [
        {
          url: 'https://myrestaurant.com',
          metadata: { title: 'My Restaurant' },
          markdown: 'Kitchen hours: Mon-Fri 12pm-9pm',
        },
        {
          url: 'https://eater.com/top-10-restaurants-nyc',
          metadata: { title: 'Top 10 Restaurants in NYC' },
          markdown: '',
        },
        {
          url: 'https://www.instagram.com/p/ABC123/',
          metadata: { title: 'Food photo post' },
          markdown: '',
        },
      ],
    });

    const venues = await searchVenues({ location: 'Brooklyn, NY' });
    expect(venues).toHaveLength(1);
    expect(venues[0].name).toBe('My Restaurant');

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
