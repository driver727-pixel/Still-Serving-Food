'use strict';

const https = require('https');
const {
  searchPlaces,
  isFoodEstablishment,
  parseOpeningPeriods,
  parseNewApiPeriods,
} = require('../functions/placesClient');

jest.mock('https');

// ---------------------------------------------------------------------------
// isFoodEstablishment
// ---------------------------------------------------------------------------
describe('isFoodEstablishment', () => {
  test('returns true for restaurant type', () => {
    expect(isFoodEstablishment(['restaurant', 'point_of_interest'])).toBe(true);
  });

  test('returns true for bar type', () => {
    expect(isFoodEstablishment(['bar', 'establishment'])).toBe(true);
  });

  test('returns true for cafe type', () => {
    expect(isFoodEstablishment(['cafe'])).toBe(true);
  });

  test('returns true for bakery type', () => {
    expect(isFoodEstablishment(['bakery', 'establishment'])).toBe(true);
  });

  test('returns true for meal_delivery type', () => {
    expect(isFoodEstablishment(['meal_delivery'])).toBe(true);
  });

  test('returns true for meal_takeaway type', () => {
    expect(isFoodEstablishment(['meal_takeaway'])).toBe(true);
  });

  test('returns false for unrelated types', () => {
    expect(isFoodEstablishment(['parking', 'establishment'])).toBe(false);
  });

  test('returns false for empty array', () => {
    expect(isFoodEstablishment([])).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isFoodEstablishment(null)).toBe(false);
    expect(isFoodEstablishment(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchPlaces
// ---------------------------------------------------------------------------

/**
 * Helper: make https.get resolve with a fake API response.
 * Supports sequential calls (text search first, then place details).
 */
function mockHttpSequence(responses) {
  let callIndex = 0;
  https.get.mockImplementation((url, cb) => {
    const response = responses[callIndex % responses.length];
    callIndex++;

    const body = JSON.stringify(response);
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

const TEXT_SEARCH_RESPONSE = {
  status: 'OK',
  results: [
    {
      place_id: 'place_abc',
      name: 'The Crown',
      types: ['restaurant', 'food', 'point_of_interest'],
    },
    {
      place_id: 'place_def',
      name: 'Parking Garage 5',
      types: ['parking', 'establishment'],
    },
  ],
};

const DETAILS_RESPONSE = {
  status: 'OK',
  result: {
    place_id: 'place_abc',
    name: 'The Crown',
    formatted_address: '1 Main St, Brooklyn, NY',
    website: 'https://thecrown.com',
    geometry: { location: { lat: 40.7, lng: -73.9 } },
    types: ['restaurant'],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GOOGLE_PLACES_API_KEY;
});

test('throws when GOOGLE_PLACES_API_KEY is not set', async () => {
  await expect(searchPlaces({ location: 'Brooklyn' })).rejects.toThrow(
    /GOOGLE_PLACES_API_KEY/,
  );
});

test('throws when no location is provided', async () => {
  await expect(searchPlaces({ apiKey: 'key' })).rejects.toThrow(/location/i);
});

test('throws when location is empty string', async () => {
  await expect(searchPlaces({ location: '   ', apiKey: 'key' })).rejects.toThrow(/location/i);
});

test('throws on non-OK Places API status', async () => {
  https.get.mockImplementation((url, cb) => {
    const body = JSON.stringify({ status: 'REQUEST_DENIED', error_message: 'Invalid key' });
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

  await expect(searchPlaces({ location: 'Brooklyn', apiKey: 'bad' })).rejects.toThrow(
    /REQUEST_DENIED/,
  );
});

test('returns ZERO_RESULTS as empty array', async () => {
  https.get.mockImplementation((url, cb) => {
    const body = JSON.stringify({ status: 'ZERO_RESULTS', results: [] });
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

  const result = await searchPlaces({ location: 'Nowhere', apiKey: 'key' });
  expect(result).toEqual([]);
});

test('filters out non-food establishments from text search results', async () => {
  // Text search: 2 results (1 restaurant, 1 parking)
  // Details: only restaurant details (parking was filtered out)
  mockHttpSequence([TEXT_SEARCH_RESPONSE, DETAILS_RESPONSE]);

  const result = await searchPlaces({ location: 'Brooklyn', apiKey: 'key' });

  // Only restaurant passes the food-type filter; parking is excluded
  expect(result).toHaveLength(1);
  expect(result[0].name).toBe('The Crown');
  expect(result[0].website).toBe('https://thecrown.com');
  expect(result[0].placeId).toBe('place_abc');
});

test('returns null website when place details have no website field', async () => {
  const noWebsite = {
    status: 'OK',
    result: {
      place_id: 'place_abc',
      name: 'No Web Bar',
      formatted_address: '2 Main St',
      geometry: { location: { lat: 40.7, lng: -73.9 } },
      types: ['bar'],
    },
  };

  const textSearch = {
    status: 'OK',
    results: [{ place_id: 'place_abc', types: ['bar'] }],
  };

  mockHttpSequence([textSearch, noWebsite]);

  const result = await searchPlaces({ location: 'Brooklyn', apiKey: 'key' });
  expect(result[0].website).toBeNull();
});

test('respects limit parameter', async () => {
  const manyResults = {
    status: 'OK',
    results: Array.from({ length: 15 }, (_, i) => ({
      place_id: `place_${i}`,
      types: ['restaurant'],
    })),
  };

  const detailsFactory = (i) => ({
    status: 'OK',
    result: {
      place_id: `place_${i}`,
      name: `Restaurant ${i}`,
      formatted_address: `${i} Main St`,
      geometry: { location: { lat: 40.7, lng: -73.9 } },
      types: ['restaurant'],
    },
  });

  let callIndex = 0;
  https.get.mockImplementation((url, cb) => {
    const response = callIndex === 0 ? manyResults : detailsFactory(callIndex - 1);
    callIndex++;
    const body = JSON.stringify(response);
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

  const result = await searchPlaces({ location: 'Brooklyn', limit: 5, apiKey: 'key' });
  expect(result.length).toBeLessThanOrEqual(5);
});


// ---------------------------------------------------------------------------
// parseOpeningPeriods
// ---------------------------------------------------------------------------
describe('parseOpeningPeriods', () => {
  test('converts Legacy periods to HourBlocks', () => {
    const periods = [
      { open: { day: 1, time: '1200' }, close: { day: 1, time: '2200' } },
      { open: { day: 5, time: '1100' }, close: { day: 5, time: '2300' } },
    ];
    const blocks = parseOpeningPeriods(periods);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].day).toBe(1);
    expect(blocks[0].open).toBe(720);   // 12:00 → 720 min
    expect(blocks[0].close).toBe(1320); // 22:00 → 1320 min
    expect(blocks[0].label).toBe('monday');
    expect(blocks[0].inFoodSection).toBe(false);
    expect(blocks[1].day).toBe(5);
    expect(blocks[1].open).toBe(660);
    expect(blocks[1].close).toBe(1380);
    expect(blocks[1].label).toBe('friday');
  });

  test('returns empty array for null input', () => {
    expect(parseOpeningPeriods(null)).toEqual([]);
  });

  test('returns empty array for empty array input', () => {
    expect(parseOpeningPeriods([])).toEqual([]);
  });

  test('skips periods missing open or close time', () => {
    const periods = [
      { open: { day: 1 }, close: { day: 1, time: '2200' } },
      { open: { day: 2, time: '1200' } },
    ];
    expect(parseOpeningPeriods(periods)).toEqual([]);
  });

  test('parses midnight (0000) correctly', () => {
    const periods = [
      { open: { day: 0, time: '0000' }, close: { day: 0, time: '2359' } },
    ];
    const blocks = parseOpeningPeriods(periods);
    expect(blocks[0].open).toBe(0);
    expect(blocks[0].close).toBe(1439);
  });

  test('handles Sunday (day 0) correctly', () => {
    const periods = [{ open: { day: 0, time: '1000' }, close: { day: 0, time: '2000' } }];
    const blocks = parseOpeningPeriods(periods);
    expect(blocks[0].day).toBe(0);
    expect(blocks[0].label).toBe('sunday');
  });
});

// ---------------------------------------------------------------------------
// parseNewApiPeriods
// ---------------------------------------------------------------------------
describe('parseNewApiPeriods', () => {
  test('converts Places API (New) kitchen periods to HourBlocks with inFoodSection=true', () => {
    const periods = [
      { open: { day: 1, hour: 11, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } },
      { open: { day: 6, hour: 10, minute: 30 }, close: { day: 6, hour: 23, minute: 0 } },
    ];
    const blocks = parseNewApiPeriods(periods);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].day).toBe(1);
    expect(blocks[0].open).toBe(660);
    expect(blocks[0].close).toBe(1320);
    expect(blocks[0].inFoodSection).toBe(true);
    expect(blocks[1].day).toBe(6);
    expect(blocks[1].open).toBe(630); // 10:30 → 630 min
    expect(blocks[1].close).toBe(1380);
  });

  test('defaults minute to 0 when not provided', () => {
    const periods = [{ open: { day: 2, hour: 9 }, close: { day: 2, hour: 21 } }];
    const blocks = parseNewApiPeriods(periods);
    expect(blocks[0].open).toBe(540);
    expect(blocks[0].close).toBe(1260);
  });

  test('returns empty array for null input', () => {
    expect(parseNewApiPeriods(null)).toEqual([]);
  });

  test('skips periods missing hour fields', () => {
    const periods = [{ open: { day: 1 }, close: { day: 1, hour: 22 } }];
    expect(parseNewApiPeriods(periods)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchPlaces — openingHours and kitchenHours fields
// ---------------------------------------------------------------------------
test('includes openingHours from Legacy Place Details when periods are present', async () => {
  const textSearchWithOne = {
    status: 'OK',
    results: [{ place_id: 'place_abc', types: ['restaurant'] }],
  };
  const detailsWithHours = {
    status: 'OK',
    result: {
      place_id: 'place_abc',
      name: 'The Crown',
      formatted_address: '1 Main St',
      website: 'https://thecrown.com',
      geometry: { location: { lat: 40.7, lng: -73.9 } },
      types: ['restaurant'],
      opening_hours: {
        periods: [
          { open: { day: 1, time: '1200' }, close: { day: 1, time: '2200' } },
        ],
      },
    },
  };
  // Third call: fetchSecondaryHours (Places API New) → no kitchen hours
  const noSecondaryHours = {};

  let callCount = 0;
  https.get.mockImplementation((_options, cb) => {
    const responses = [textSearchWithOne, detailsWithHours, noSecondaryHours];
    const body = JSON.stringify(responses[callCount % responses.length]);
    callCount++;
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

  const result = await searchPlaces({ location: 'Brooklyn', apiKey: 'key' });
  expect(result).toHaveLength(1);
  expect(result[0].openingHours).not.toBeNull();
  expect(result[0].openingHours).toHaveLength(1);
  expect(result[0].openingHours[0].day).toBe(1);
  expect(result[0].kitchenHours).toBeNull();
});
