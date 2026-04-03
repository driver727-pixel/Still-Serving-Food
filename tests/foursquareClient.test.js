'use strict';

const https = require('https');

jest.mock('https');

const {
  parseFoursquareHoursToBlocks,
  enrichVenuesWithFoursquareData,
  searchFoursquareVenues,
  fetchFoursquarePlaceDetails,
} = require('../functions/foursquareClient');

// ---------------------------------------------------------------------------
// HTTP mock helper
// ---------------------------------------------------------------------------

/**
 * Queue of responses for sequential https.get calls.
 * Each search + details call uses a separate invocation.
 */
function mockGetSequence(responses) {
  let idx = 0;
  https.get.mockImplementation((_options, cb) => {
    const payload = responses[idx % responses.length];
    idx++;
    const body = JSON.stringify(payload);
    const fakeRes = {
      on: (event, handler) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
        return fakeRes;
      },
    };
    cb(fakeRes);
    return { on: jest.fn() };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FOURSQUARE_API_KEY;
});

// ---------------------------------------------------------------------------
// parseFoursquareHoursToBlocks
// ---------------------------------------------------------------------------
describe('parseFoursquareHoursToBlocks', () => {
  test('converts Foursquare Monday (1) to JS Monday (1)', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 1, open: '1200', close: '2200' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].day).toBe(1);
    expect(blocks[0].open).toBe(720);
    expect(blocks[0].close).toBe(1320);
    expect(blocks[0].label).toBe('monday');
  });

  test('converts Foursquare Sunday (7) to JS Sunday (0)', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 7, open: '1000', close: '2000' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].day).toBe(0);
    expect(blocks[0].label).toBe('sunday');
  });

  test('converts Foursquare Saturday (6) to JS Saturday (6)', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 6, open: '0900', close: '2300' }] });
    expect(blocks[0].day).toBe(6);
    expect(blocks[0].label).toBe('saturday');
  });

  test('handles multiple days', () => {
    const fsqHours = {
      regular: [
        { day: 1, open: '1100', close: '2200' },
        { day: 2, open: '1100', close: '2200' },
        { day: 5, open: '1100', close: '2300' },
        { day: 7, open: '1200', close: '2100' },
      ],
    };
    const blocks = parseFoursquareHoursToBlocks(fsqHours);
    expect(blocks).toHaveLength(4);
  });

  test('parses open/close as HHMM strings', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 3, open: '0930', close: '2130' }] });
    expect(blocks[0].open).toBe(570);  // 9*60+30
    expect(blocks[0].close).toBe(1290); // 21*60+30
  });

  test('returns empty array for null input', () => {
    expect(parseFoursquareHoursToBlocks(null)).toEqual([]);
  });

  test('returns empty array for missing regular array', () => {
    expect(parseFoursquareHoursToBlocks({})).toEqual([]);
  });

  test('skips slots with missing open or close', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 1 }] });
    expect(blocks).toEqual([]);
  });

  test('pads short open/close strings to 4 digits', () => {
    const blocks = parseFoursquareHoursToBlocks({ regular: [{ day: 1, open: '900', close: '2200' }] });
    // '900' padded to '0900' → 9:00 → 540 minutes
    expect(blocks[0].open).toBe(540);
  });
});

// ---------------------------------------------------------------------------
// fetchFoursquarePlaceDetails
// ---------------------------------------------------------------------------
describe('fetchFoursquarePlaceDetails', () => {
  test('returns hourBlocks and tipTexts for a valid place', async () => {
    mockGetSequence([
      {
        name: 'The Crown',
        hours: { regular: [{ day: 1, open: '1200', close: '2200' }] },
        tips: [{ text: 'Kitchen closes at 10pm' }, { text: 'Great burgers' }],
      },
    ]);

    const result = await fetchFoursquarePlaceDetails('fsq123', 'test-key');
    expect(result.hourBlocks).toHaveLength(1);
    expect(result.tipTexts).toContain('Kitchen closes at 10pm');
  });

  test('returns null when API returns an error message', async () => {
    mockGetSequence([{ message: 'Endpoint not found' }]);
    const result = await fetchFoursquarePlaceDetails('bad_id', 'key');
    expect(result).toBeNull();
  });

  test('returns empty hourBlocks and tipTexts when fields are missing', async () => {
    mockGetSequence([{ name: 'Minimal Bar' }]);
    const result = await fetchFoursquarePlaceDetails('fsq999', 'key');
    expect(result.hourBlocks).toEqual([]);
    expect(result.tipTexts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchFoursquareVenues
// ---------------------------------------------------------------------------
describe('searchFoursquareVenues', () => {
  test('throws when FOURSQUARE_API_KEY is not set', async () => {
    await expect(searchFoursquareVenues({ location: 'Brooklyn' })).rejects.toThrow(
      /FOURSQUARE_API_KEY/,
    );
  });

  test('throws when no location provided', async () => {
    await expect(
      searchFoursquareVenues({ location: '', apiKey: 'fsq3-key' }),
    ).rejects.toThrow(/location/i);
  });

  test('throws on Foursquare API error response', async () => {
    mockGetSequence([{ message: 'Unauthorized' }]);
    await expect(
      searchFoursquareVenues({ location: 'Brooklyn', apiKey: 'bad-key' }),
    ).rejects.toThrow(/Foursquare Places search failed/);
  });

  test('returns venues with hourBlocks from details endpoint', async () => {
    // First call: search results
    const searchResponse = {
      results: [
        { fsq_id: 'fsq1', name: 'The Crown', location: { address: '1 Main St', locality: 'Brooklyn', region: 'NY' } },
      ],
    };
    // Second call: place details
    const detailsResponse = {
      name: 'The Crown',
      hours: { regular: [{ day: 1, open: '1200', close: '2200' }] },
      tips: [{ text: 'Great kitchen until 10' }],
    };

    mockGetSequence([searchResponse, detailsResponse]);

    const venues = await searchFoursquareVenues({ location: 'Brooklyn', apiKey: 'fsq3-key' });
    expect(venues).toHaveLength(1);
    expect(venues[0].name).toBe('The Crown');
    expect(venues[0].hourBlocks).toHaveLength(1);
    expect(venues[0].tipTexts).toContain('Great kitchen until 10');
    expect(venues[0].address).toContain('Brooklyn');
  });

  test('returns empty array when search returns no results', async () => {
    mockGetSequence([{ results: [] }]);
    const venues = await searchFoursquareVenues({ location: 'Nowhere', apiKey: 'fsq3-key' });
    expect(venues).toEqual([]);
  });

  test('uses FOURSQUARE_API_KEY env var when no apiKey option provided', async () => {
    process.env.FOURSQUARE_API_KEY = 'fsq3-from-env';
    mockGetSequence([{ results: [] }]);
    const venues = await searchFoursquareVenues({ location: 'Brooklyn' });
    expect(venues).toEqual([]);
    delete process.env.FOURSQUARE_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// enrichVenuesWithFoursquareData
// ---------------------------------------------------------------------------
describe('enrichVenuesWithFoursquareData', () => {
  const BASE_VENUE = {
    name: 'The Crown',
    url: 'https://example.com',
    description: '1 Main St',
    hourBlocks: [],
    is24Hours: false,
    serving: false,
    opensAt: null,
    closesAt: null,
    callForHours: false,
    hoursSource: null,
    scrapedAt: new Date().toISOString(),
  };

  test('enriches a venue with Foursquare structured hours', () => {
    const fsqVenues = [
      {
        name: 'The Crown',
        hourBlocks: [{ day: 1, open: 720, close: 1320, label: 'monday', inFoodSection: false }],
        tipTexts: [],
      },
    ];
    const result = enrichVenuesWithFoursquareData([BASE_VENUE], fsqVenues);
    expect(result[0].hourBlocks).toHaveLength(1);
    expect(result[0].hoursSource).toBe('foursquare');
  });

  test('falls back to tip text parsing when no structured hours', () => {
    const fsqVenues = [
      {
        name: 'The Crown',
        hourBlocks: [],
        tipTexts: ['Kitchen closes at 10pm every day'],
      },
    ];
    const result = enrichVenuesWithFoursquareData([BASE_VENUE], fsqVenues);
    expect(result[0].hourBlocks.length).toBeGreaterThan(0);
    expect(result[0].hoursSource).toBe('foursquare_tip');
  });

  test('skips venues that already have hourBlocks', () => {
    const venueWithHours = {
      ...BASE_VENUE,
      hourBlocks: [{ day: 1, open: 660, close: 1260, label: 'monday', inFoodSection: false }],
    };
    const fsqVenues = [
      { name: 'The Crown', hourBlocks: [{ day: 2, open: 720, close: 1320, label: 'tuesday', inFoodSection: false }], tipTexts: [] },
    ];
    const result = enrichVenuesWithFoursquareData([venueWithHours], fsqVenues);
    // Should not be replaced
    expect(result[0].hourBlocks[0].open).toBe(660);
  });

  test('skips venues with no matching Foursquare entry', () => {
    const fsqVenues = [{ name: 'Some Other Place', hourBlocks: [], tipTexts: [] }];
    const result = enrichVenuesWithFoursquareData([BASE_VENUE], fsqVenues);
    expect(result[0].hourBlocks).toEqual([]);
    expect(result[0].hoursSource).toBeNull();
  });

  test('name matching is case-insensitive', () => {
    const fsqVenues = [
      {
        name: 'the crown',
        hourBlocks: [{ day: 3, open: 720, close: 1320, label: 'wednesday', inFoodSection: false }],
        tipTexts: [],
      },
    ];
    const result = enrichVenuesWithFoursquareData([BASE_VENUE], fsqVenues);
    expect(result[0].hourBlocks.length).toBeGreaterThan(0);
  });
});
