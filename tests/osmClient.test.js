'use strict';

const https = require('https');

jest.mock('https');

const {
  geocodeLocation,
  convertOsmOpeningHours,
  enrichVenuesWithOsmData,
  buildVenuesFromOsmData,
  parseOsmElement,
  buildBbox,
  searchOsmVenues,
} = require('../functions/osmClient');

// ---------------------------------------------------------------------------
// HTTP mock helpers
// ---------------------------------------------------------------------------

/**
 * Configure https.get to respond with the given JSON payload.
 * Returns the mock function for call-count assertions.
 */
function mockGet(payload) {
  const body = JSON.stringify(payload);
  https.get.mockImplementation((_options, cb) => {
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

/**
 * Configure https.request to respond with the given JSON payload (for POST).
 */
function mockPost(payload) {
  const body = JSON.stringify(payload);
  https.request.mockImplementation((_options, cb) => {
    const fakeRes = {
      on: (event, handler) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
        return fakeRes;
      },
    };
    cb(fakeRes);
    // Return a fake request object with write/end/on methods
    return { write: jest.fn(), end: jest.fn(), on: jest.fn() };
  });
}

/**
 * Set up https.get for Nominatim + https.request for Overpass sequentially.
 */
function mockNominatimAndOverpass(nominatimResponse, overpassResponse) {
  mockGet(nominatimResponse);
  mockPost(overpassResponse);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// convertOsmOpeningHours
// ---------------------------------------------------------------------------
describe('convertOsmOpeningHours', () => {
  test('converts two-letter day abbreviations to three-letter', () => {
    expect(convertOsmOpeningHours('Mo-Fr 10:00-22:00')).toBe('Mon-Fri 10:00-22:00');
  });

  test('converts all two-letter day abbreviations', () => {
    const input = 'Mo Tu We Th Fr Sa Su';
    const output = convertOsmOpeningHours(input);
    expect(output).toBe('Mon Tue Wed Thu Fri Sat Sun');
  });

  test('replaces semicolons with newlines', () => {
    const converted = convertOsmOpeningHours('Mo-Fr 11:00-22:00; Sa-Su 12:00-23:00');
    expect(converted).toContain('\n');
    expect(converted).toBe('Mon-Fri 11:00-22:00\n Sat-Sun 12:00-23:00');
  });

  test('replaces commas with newlines', () => {
    const converted = convertOsmOpeningHours('Mo-Fr 10:00-22:00, Sa 10:00-23:00');
    expect(converted).toContain('\n');
  });

  test('passes through "24/7" unchanged', () => {
    expect(convertOsmOpeningHours('24/7')).toBe('24/7');
  });

  test('returns empty string for null input', () => {
    expect(convertOsmOpeningHours(null)).toBe('');
  });

  test('returns empty string for empty string input', () => {
    expect(convertOsmOpeningHours('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildBbox
// ---------------------------------------------------------------------------
describe('buildBbox', () => {
  test('returns south/north/west/east bounding box', () => {
    const bbox = buildBbox(40.7, -73.9, 5);
    expect(bbox.south).toBeLessThan(40.7);
    expect(bbox.north).toBeGreaterThan(40.7);
    expect(bbox.west).toBeLessThan(-73.9);
    expect(bbox.east).toBeGreaterThan(-73.9);
  });

  test('larger radius produces wider bbox', () => {
    const small = buildBbox(40.7, -73.9, 1);
    const large = buildBbox(40.7, -73.9, 10);
    expect(large.north - large.south).toBeGreaterThan(small.north - small.south);
  });
});

// ---------------------------------------------------------------------------
// parseOsmElement
// ---------------------------------------------------------------------------
describe('parseOsmElement', () => {
  test('parses a node with opening_hours', () => {
    const el = {
      type: 'node',
      id: 123,
      lat: 40.7,
      lon: -73.9,
      tags: {
        name: 'The Crown',
        amenity: 'restaurant',
        opening_hours: 'Mo-Fr 11:00-22:00',
      },
    };
    const result = parseOsmElement(el);
    expect(result.name).toBe('The Crown');
    expect(result.lat).toBe(40.7);
    expect(result.lng).toBe(-73.9);
    expect(result.openingHoursText).toBe('Mo-Fr 11:00-22:00');
    expect(result.kitchenHoursText).toBe('');
  });

  test('parses a way with kitchen:opening_hours', () => {
    const el = {
      type: 'way',
      id: 456,
      center: { lat: 40.71, lon: -73.91 },
      tags: {
        name: 'Grill House',
        amenity: 'restaurant',
        'kitchen:opening_hours': 'Mo-Sa 12:00-21:00',
      },
    };
    const result = parseOsmElement(el);
    expect(result.name).toBe('Grill House');
    expect(result.lat).toBe(40.71);
    expect(result.lng).toBe(-73.91);
    expect(result.kitchenHoursText).toBe('Mo-Sa 12:00-21:00');
  });

  test('returns null when element has no name tag', () => {
    const el = { type: 'node', lat: 40.7, lon: -73.9, tags: { amenity: 'restaurant' } };
    expect(parseOsmElement(el)).toBeNull();
  });

  test('prefers center coords for ways over direct lat/lon', () => {
    const el = {
      type: 'way',
      lat: 0,
      lon: 0,
      center: { lat: 40.7, lon: -73.9 },
      tags: { name: 'Test Bar' },
    };
    const result = parseOsmElement(el);
    expect(result.lat).toBe(40.7);
    expect(result.lng).toBe(-73.9);
  });
});

// ---------------------------------------------------------------------------
// geocodeLocation
// ---------------------------------------------------------------------------
describe('geocodeLocation', () => {
  test('returns lat/lng from Nominatim response', async () => {
    mockGet([{ lat: '40.6526006', lon: '-73.9497211', display_name: 'Brooklyn' }]);
    const result = await geocodeLocation('Brooklyn, NY');
    expect(result.lat).toBeCloseTo(40.65);
    expect(result.lng).toBeCloseTo(-73.95);
  });

  test('throws when location string is empty', async () => {
    await expect(geocodeLocation('')).rejects.toThrow(/location string is required/i);
  });

  test('throws when Nominatim returns empty array', async () => {
    mockGet([]);
    await expect(geocodeLocation('Nowhere Special')).rejects.toThrow(/no results/i);
  });

  test('throws when Nominatim returns non-array', async () => {
    mockGet({ error: 'Unknown error' });
    await expect(geocodeLocation('Test City')).rejects.toThrow(/no results/i);
  });
});

// ---------------------------------------------------------------------------
// enrichVenuesWithOsmData
// ---------------------------------------------------------------------------
describe('enrichVenuesWithOsmData', () => {
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

  test('enriches a venue with no hours using OSM opening_hours', () => {
    const osmVenues = [
      { name: 'The Crown', openingHoursText: 'Mo-Fr 11:00-22:00', kitchenHoursText: '' },
    ];
    const result = enrichVenuesWithOsmData([BASE_VENUE], osmVenues);
    expect(result[0].hourBlocks.length).toBeGreaterThan(0);
    expect(result[0].hoursSource).toBe('osm');
  });

  test('prefers kitchen:opening_hours over opening_hours', () => {
    const osmVenues = [
      {
        name: 'The Crown',
        openingHoursText: 'Mo-Fr 11:00-23:00',
        kitchenHoursText: 'Mo-Fr 11:00-21:00',
      },
    ];
    const result = enrichVenuesWithOsmData([BASE_VENUE], osmVenues);
    expect(result[0].hoursSource).toBe('osm_kitchen');
  });

  test('skips venues that already have hourBlocks', () => {
    const venueWithHours = {
      ...BASE_VENUE,
      hourBlocks: [{ day: 1, open: 720, close: 1260, label: 'monday', inFoodSection: false }],
    };
    const osmVenues = [{ name: 'The Crown', openingHoursText: 'Mo-Fr 08:00-20:00', kitchenHoursText: '' }];
    const result = enrichVenuesWithOsmData([venueWithHours], osmVenues);
    // Hours should not change
    expect(result[0].hourBlocks).toHaveLength(1);
    expect(result[0].hourBlocks[0].open).toBe(720);
  });

  test('skips venues with no matching OSM entry', () => {
    const osmVenues = [{ name: 'Some Other Bar', openingHoursText: 'Mo-Fr 11:00-22:00', kitchenHoursText: '' }];
    const result = enrichVenuesWithOsmData([BASE_VENUE], osmVenues);
    expect(result[0].hourBlocks).toEqual([]);
    expect(result[0].hoursSource).toBeNull();
  });

  test('name matching is case-insensitive and ignores punctuation', () => {
    const osmVenues = [
      { name: "the crown's pub", openingHoursText: 'Mo-Fr 11:00-22:00', kitchenHoursText: '' },
    ];
    const venue = { ...BASE_VENUE, name: "The Crown's Pub" };
    const result = enrichVenuesWithOsmData([venue], osmVenues);
    expect(result[0].hourBlocks.length).toBeGreaterThan(0);
  });

  test('handles OSM venue with no hours text', () => {
    const osmVenues = [{ name: 'The Crown', openingHoursText: '', kitchenHoursText: '' }];
    const result = enrichVenuesWithOsmData([BASE_VENUE], osmVenues);
    expect(result[0].hourBlocks).toEqual([]);
  });

  test('detects 24/7 from OSM hours', () => {
    const osmVenues = [{ name: 'The Crown', openingHoursText: '24/7', kitchenHoursText: '' }];
    const result = enrichVenuesWithOsmData([BASE_VENUE], osmVenues);
    expect(result[0].is24Hours).toBe(true);
    expect(result[0].serving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchOsmVenues — integration of geocode + overpass
// ---------------------------------------------------------------------------
describe('searchOsmVenues', () => {
  test('geocodes location and queries Overpass, returning parsed venues', async () => {
    mockGet([{ lat: '40.65', lon: '-73.95' }]);
    mockPost({
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 40.65,
          lon: -73.95,
          tags: {
            name: 'Test Restaurant',
            amenity: 'restaurant',
            opening_hours: 'Mo-Fr 12:00-22:00',
          },
        },
        {
          type: 'node',
          id: 2,
          lat: 40.66,
          lon: -73.96,
          tags: {
            name: 'Kitchen Bar',
            amenity: 'bar',
            'kitchen:opening_hours': 'Mo-Sa 17:00-23:00',
          },
        },
        // Element without a name — should be filtered out
        { type: 'node', id: 3, lat: 40.67, lon: -73.97, tags: { amenity: 'cafe' } },
      ],
    });

    const venues = await searchOsmVenues({ location: 'Brooklyn, NY' });
    expect(venues).toHaveLength(2);
    expect(venues[0].name).toBe('Test Restaurant');
    expect(venues[0].openingHoursText).toBe('Mo-Fr 12:00-22:00');
    expect(venues[1].name).toBe('Kitchen Bar');
    expect(venues[1].kitchenHoursText).toBe('Mo-Sa 17:00-23:00');
  });

  test('respects the limit parameter', async () => {
    mockGet([{ lat: '40.65', lon: '-73.95' }]);
    mockPost({
      elements: Array.from({ length: 10 }, (_, i) => ({
        type: 'node',
        id: i,
        lat: 40.65,
        lon: -73.95,
        tags: { name: `Venue ${i}`, amenity: 'restaurant', opening_hours: 'Mo-Fr 10:00-22:00' },
      })),
    });

    const venues = await searchOsmVenues({ location: 'Brooklyn', limit: 3 });
    expect(venues).toHaveLength(3);
  });

  test('returns empty array when Overpass returns no elements', async () => {
    mockGet([{ lat: '40.65', lon: '-73.95' }]);
    mockPost({ elements: [] });

    const venues = await searchOsmVenues({ location: 'Nowhere' });
    expect(venues).toEqual([]);
  });

  test('propagates geocoding failure', async () => {
    mockGet([]);
    await expect(searchOsmVenues({ location: 'Unknown Place' })).rejects.toThrow(/no results/i);
  });
});

// ---------------------------------------------------------------------------
// parseOsmElement — address and website enrichment
// ---------------------------------------------------------------------------
describe('parseOsmElement address and website fields', () => {
  test('builds address from addr: tags', () => {
    const el = {
      type: 'node',
      lat: 43.07,
      lon: -89.38,
      tags: {
        name: "McDonald's",
        amenity: 'fast_food',
        'addr:housenumber': '4020',
        'addr:street': 'Milwaukee St',
        'addr:city': 'Madison',
        'addr:state': 'WI',
        opening_hours: '24/7',
      },
    };
    const result = parseOsmElement(el);
    expect(result.name).toBe("McDonald's");
    expect(result.address).toBe('4020 Milwaukee St, Madison, WI');
    expect(result.openingHoursText).toBe('24/7');
  });

  test('returns empty address when addr: tags are absent', () => {
    const el = {
      type: 'node',
      lat: 40.7,
      lon: -73.9,
      tags: { name: 'Test Cafe', amenity: 'cafe' },
    };
    const result = parseOsmElement(el);
    expect(result.address).toBe('');
  });

  test('captures website tag', () => {
    const el = {
      type: 'node',
      lat: 40.7,
      lon: -73.9,
      tags: { name: 'Test Bar', amenity: 'bar', website: 'https://testbar.com' },
    };
    const result = parseOsmElement(el);
    expect(result.website).toBe('https://testbar.com');
  });

  test('returns empty website when no website tag', () => {
    const el = {
      type: 'node',
      lat: 40.7,
      lon: -73.9,
      tags: { name: 'Test Bar', amenity: 'bar' },
    };
    const result = parseOsmElement(el);
    expect(result.website).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildVenuesFromOsmData — converts OSM results to Venue objects
// ---------------------------------------------------------------------------
describe('buildVenuesFromOsmData', () => {
  test('converts OSM venues with opening_hours into Venue objects', () => {
    const osmVenues = [
      {
        name: 'Test Restaurant',
        address: '1 Main St, Brooklyn, NY',
        website: 'https://testrestaurant.com',
        openingHoursText: 'Mo-Fr 11:00-22:00',
        kitchenHoursText: '',
      },
    ];
    const result = buildVenuesFromOsmData(osmVenues);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Test Restaurant');
    expect(result[0].description).toBe('1 Main St, Brooklyn, NY');
    expect(result[0].url).toBe('https://testrestaurant.com');
    expect(result[0].hourBlocks.length).toBeGreaterThan(0);
    expect(result[0].hoursSource).toBe('osm');
    expect(result[0].callForHours).toBe(false);
  });

  test('sets is24Hours and serving=true for 24/7 venues', () => {
    const osmVenues = [
      {
        name: "McDonald's",
        address: '4020 Milwaukee St, Madison, WI',
        website: '',
        openingHoursText: '24/7',
        kitchenHoursText: '',
      },
    ];
    const result = buildVenuesFromOsmData(osmVenues);
    expect(result[0].is24Hours).toBe(true);
    expect(result[0].serving).toBe(true);
    expect(result[0].hoursSource).toBe('osm');
  });

  test('prefers kitchenHoursText and sets hoursSource to osm_kitchen', () => {
    const osmVenues = [
      {
        name: 'Grill House',
        address: '',
        website: '',
        openingHoursText: 'Mo-Fr 10:00-23:00',
        kitchenHoursText: 'Mo-Fr 11:00-21:00',
      },
    ];
    const result = buildVenuesFromOsmData(osmVenues);
    expect(result[0].hoursSource).toBe('osm_kitchen');
  });

  test('sets callForHours=true when no hours text is available', () => {
    const osmVenues = [
      {
        name: 'Mystery Cafe',
        address: '',
        website: '',
        openingHoursText: '',
        kitchenHoursText: '',
      },
    ];
    const result = buildVenuesFromOsmData(osmVenues);
    expect(result[0].callForHours).toBe(true);
    expect(result[0].hoursSource).toBeNull();
  });

  test('returns empty array for empty input', () => {
    expect(buildVenuesFromOsmData([])).toEqual([]);
  });
});
