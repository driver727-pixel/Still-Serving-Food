'use strict';

const https = require('https');
const { searchPlaces, isFoodEstablishment } = require('../functions/placesClient');

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
