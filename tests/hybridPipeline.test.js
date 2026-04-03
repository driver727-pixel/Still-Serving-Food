'use strict';

jest.mock('../functions/placesClient');
jest.mock('../functions/facebookResolver');
jest.mock('../functions/facebookScraper');
jest.mock('../functions/instagramScraper');
jest.mock('../functions/osmClient');
jest.mock('../functions/foursquareClient');

const { searchPlaces } = require('../functions/placesClient');
const { resolveFacebookUrl, resolveInstagramUrl } = require('../functions/facebookResolver');
const { scrapeFacebookPage } = require('../functions/facebookScraper');
const { scrapeInstagramPage } = require('../functions/instagramScraper');
const { searchOsmVenues, enrichVenuesWithOsmData } = require('../functions/osmClient');
const { searchFoursquareVenues, enrichVenuesWithFoursquareData } = require('../functions/foursquareClient');
const { runHybridPipeline, mergeVenue, buildVenueFromPlace } = require('../functions/hybridPipeline');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PLACE_WITH_FB = {
  placeId: 'place_abc',
  name: 'The Crown',
  address: '1 Main St, Brooklyn, NY',
  website: 'https://www.facebook.com/TheCrown',
  lat: 40.7,
  lng: -73.9,
  types: ['restaurant'],
};

const PLACE_WITHOUT_FB = {
  placeId: 'place_def',
  name: 'Quiet Cafe',
  address: '2 Side St, Brooklyn, NY',
  website: 'https://quietcafe.com',
  lat: 40.71,
  lng: -73.91,
  types: ['cafe'],
};

const FB_DATA = {
  facebookUrl: 'https://www.facebook.com/TheCrown',
  aboutText: 'Kitchen hours: Mon-Fri 12pm-9pm',
  recentPosts: [],
  hitLoginWall: false,
  scraper: 'firecrawl',
  hourBlocks: [{ day: 1, open: 720, close: 1260, label: 'monday', inFoodSection: true }],
  is24Hours: false,
  serving: false,
  opensAt: null,
  closesAt: '9:00 PM',
  hoursSource: 'facebook_about',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GOOGLE_PLACES_API_KEY;

  // Default mocks: return null/empty for all new optional sources
  resolveInstagramUrl.mockResolvedValue(null);
  scrapeInstagramPage.mockResolvedValue(null);
  searchOsmVenues.mockResolvedValue([]);
  // enrichVenuesWithOsmData is called with (venues, osmVenues); default: return venues unchanged
  enrichVenuesWithOsmData.mockImplementation((venues) => venues);
  searchFoursquareVenues.mockResolvedValue([]);
  enrichVenuesWithFoursquareData.mockImplementation((venues) => venues);
});

// ---------------------------------------------------------------------------
// buildVenueFromPlace
// ---------------------------------------------------------------------------
describe('buildVenueFromPlace', () => {
  test('creates a venue with place entity data', () => {
    const venue = buildVenueFromPlace({ ...PLACE_WITH_FB, facebookUrl: 'https://www.facebook.com/TheCrown' });
    expect(venue.name).toBe('The Crown');
    expect(venue.url).toBe('https://www.facebook.com/TheCrown');
    expect(venue.description).toBe('1 Main St, Brooklyn, NY');
    expect(venue.placeId).toBe('place_abc');
    expect(venue.hourBlocks).toEqual([]);
    expect(venue.serving).toBe(false);
    expect(venue.hoursSource).toBeNull();
    expect(venue.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('uses empty string for url when no website', () => {
    const venue = buildVenueFromPlace({ ...PLACE_WITH_FB, website: null });
    expect(venue.url).toBe('');
  });
});

// ---------------------------------------------------------------------------
// mergeVenue
// ---------------------------------------------------------------------------
describe('mergeVenue', () => {
  test('merges FB hours into the venue', () => {
    const venue = mergeVenue({ ...PLACE_WITH_FB, facebookUrl: 'https://www.facebook.com/TheCrown' }, FB_DATA);
    expect(venue.name).toBe('The Crown');
    expect(venue.hourBlocks).toHaveLength(1);
    expect(venue.hoursSource).toBe('facebook_about');
    expect(venue.facebookUrl).toBe('https://www.facebook.com/TheCrown');
    expect(venue.closesAt).toBe('9:00 PM');
  });

  test('sets callForHours to true when FB scraper hit a login wall', () => {
    const venue = mergeVenue(
      { ...PLACE_WITH_FB, facebookUrl: 'https://www.facebook.com/TheCrown' },
      { ...FB_DATA, hitLoginWall: true },
    );
    expect(venue.callForHours).toBe(true);
  });

  test('returns base venue when fbData is null', () => {
    const venue = mergeVenue({ ...PLACE_WITH_FB, facebookUrl: null }, null);
    expect(venue.hourBlocks).toEqual([]);
    expect(venue.hoursSource).toBeNull();
  });

  test('canonical entity identity comes from place, not fbData', () => {
    const venue = mergeVenue(
      { ...PLACE_WITH_FB, facebookUrl: 'https://www.facebook.com/TheCrown' },
      { ...FB_DATA, name: 'Different Name' },
    );
    // name must come from the Google Places entity
    expect(venue.name).toBe('The Crown');
  });

  test('uses Instagram hours when FB returns no hours', () => {
    const fbNoHours = { ...FB_DATA, hourBlocks: [], is24Hours: false, hoursSource: null, hitLoginWall: false };
    const igData = {
      igUrl: 'https://www.instagram.com/thecrown',
      recentPosts: ['Kitchen closes at 10pm'],
      hourBlocks: [{ day: 1, open: 660, close: 1320, label: 'monday', inFoodSection: true, fromHint: true }],
      is24Hours: false,
      serving: false,
      opensAt: null,
      closesAt: '10:00 PM',
      hoursSource: 'instagram_post',
    };
    const venue = mergeVenue(
      { ...PLACE_WITH_FB, facebookUrl: 'https://www.facebook.com/TheCrown' },
      fbNoHours,
      igData,
    );
    expect(venue.hoursSource).toBe('instagram_post');
    expect(venue.hourBlocks).toHaveLength(1);
  });

  test('uses Google Places kitchen hours when no social hours available', () => {
    const kitchenHours = [{ day: 1, open: 720, close: 1260, label: 'monday', inFoodSection: true }];
    const placeWithKitchenHours = {
      ...PLACE_WITH_FB,
      facebookUrl: null,
      kitchenHours,
      openingHours: null,
    };
    const venue = mergeVenue(placeWithKitchenHours, null, null);
    expect(venue.hourBlocks).toHaveLength(1);
    expect(venue.hoursSource).toBe('google_kitchen_hours');
  });

  test('falls back to Google Places opening hours when no kitchen hours', () => {
    const openingHours = [{ day: 1, open: 660, close: 1320, label: 'monday', inFoodSection: false }];
    const placeWithOpeningHours = {
      ...PLACE_WITH_FB,
      facebookUrl: null,
      kitchenHours: null,
      openingHours,
    };
    const venue = mergeVenue(placeWithOpeningHours, null, null);
    expect(venue.hourBlocks).toHaveLength(1);
    expect(venue.hoursSource).toBe('google_opening_hours');
  });
});

describe('runHybridPipeline', () => {
  test('runs all phases and returns merged venues', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB, PLACE_WITHOUT_FB]);
    resolveFacebookUrl
      .mockResolvedValueOnce('https://www.facebook.com/TheCrown')
      .mockResolvedValueOnce(null);
    scrapeFacebookPage.mockResolvedValue(FB_DATA);

    const venues = await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', firecrawlApiKey: 'fc-key' },
    );

    expect(searchPlaces).toHaveBeenCalledWith({
      location: 'Brooklyn, NY',
      limit: 10,
      apiKey: 'gp-key',
    });

    expect(resolveFacebookUrl).toHaveBeenCalledTimes(2);
    // Instagram resolution is also called for each place
    expect(resolveInstagramUrl).toHaveBeenCalledTimes(2);

    expect(scrapeFacebookPage).toHaveBeenCalledTimes(1);
    expect(scrapeFacebookPage).toHaveBeenCalledWith(
      'https://www.facebook.com/TheCrown',
      expect.objectContaining({ firecrawlApiKey: 'fc-key' }),
    );

    // FB venue gets hours; non-FB venue gets empty hours
    const crown = venues.find((v) => v.name === 'The Crown');
    const cafe = venues.find((v) => v.name === 'Quiet Cafe');

    expect(crown).toBeDefined();
    expect(crown.hourBlocks).toHaveLength(1);
    expect(crown.hoursSource).toBe('facebook_about');

    expect(cafe).toBeDefined();
    expect(cafe.hourBlocks).toEqual([]);
    expect(cafe.hoursSource).toBeNull();
  });

  test('handles Phase 2 failure gracefully (resolveFacebookUrl throws)', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockRejectedValue(new Error('Firecrawl down'));

    const venues = await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', firecrawlApiKey: 'fc-key' },
    );

    expect(venues).toHaveLength(1);
    expect(venues[0].hourBlocks).toEqual([]);
    expect(scrapeFacebookPage).not.toHaveBeenCalled();
  });

  test('handles Phase 3a failure gracefully (scrapeFacebookPage throws)', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue('https://www.facebook.com/TheCrown');
    scrapeFacebookPage.mockRejectedValue(new Error('Facebook blocked'));

    const venues = await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', firecrawlApiKey: 'fc-key' },
    );

    expect(venues).toHaveLength(1);
    expect(venues[0].hourBlocks).toEqual([]);
  });

  test('returns empty array when searchPlaces returns no results', async () => {
    searchPlaces.mockResolvedValue([]);

    const venues = await runHybridPipeline(
      { location: 'Middle of Nowhere' },
      { googlePlacesApiKey: 'gp-key' },
    );

    expect(venues).toEqual([]);
    expect(resolveFacebookUrl).not.toHaveBeenCalled();
    expect(scrapeFacebookPage).not.toHaveBeenCalled();
  });

  test('propagates Phase 1 failure', async () => {
    searchPlaces.mockRejectedValue(new Error('Places API quota exceeded'));

    await expect(
      runHybridPipeline({ location: 'Brooklyn' }, { googlePlacesApiKey: 'gp-key' }),
    ).rejects.toThrow('Places API quota exceeded');
  });

  test('respects limit option', async () => {
    searchPlaces.mockResolvedValue([]);

    await runHybridPipeline(
      { location: 'Brooklyn' },
      { limit: 5, googlePlacesApiKey: 'gp-key' },
    );

    expect(searchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  test('skips Instagram scraping when no apifyApiKey is provided', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue(null);
    resolveInstagramUrl.mockResolvedValue('https://www.instagram.com/thecrown');

    await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', firecrawlApiKey: 'fc-key' },
      // no apifyApiKey
    );

    expect(scrapeInstagramPage).not.toHaveBeenCalled();
  });

  test('runs Instagram scraping (Phase 3b) when apifyApiKey is provided and FB has no hours', async () => {
    const FB_NO_HOURS = { ...FB_DATA, hourBlocks: [], is24Hours: false, hoursSource: null };
    const IG_DATA = {
      igUrl: 'https://www.instagram.com/thecrown',
      recentPosts: ['Kitchen closes at 10pm tonight'],
      hourBlocks: [{ day: 1, open: 660, close: 1320, label: 'monday', inFoodSection: true, fromHint: true }],
      is24Hours: false,
      serving: false,
      opensAt: null,
      closesAt: '10:00 PM',
      hoursSource: 'instagram_post',
    };

    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue('https://www.facebook.com/TheCrown');
    resolveInstagramUrl.mockResolvedValue('https://www.instagram.com/thecrown');
    scrapeFacebookPage.mockResolvedValue(FB_NO_HOURS);
    scrapeInstagramPage.mockResolvedValue(IG_DATA);

    const venues = await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', firecrawlApiKey: 'fc-key', apifyApiKey: 'ap-key' },
    );

    expect(scrapeInstagramPage).toHaveBeenCalledWith(
      'https://www.instagram.com/thecrown',
      expect.objectContaining({ apifyApiKey: 'ap-key' }),
    );

    const crown = venues.find((v) => v.name === 'The Crown');
    expect(crown.hoursSource).toBe('instagram_post');
    expect(crown.hourBlocks).toHaveLength(1);
  });

  test('calls OSM enrichment (Phase 5) when location is provided', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue(null);

    await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key' },
    );

    expect(searchOsmVenues).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'Brooklyn, NY' }),
    );
    expect(enrichVenuesWithOsmData).toHaveBeenCalled();
  });

  test('calls Foursquare enrichment (Phase 6) when foursquareApiKey and location are provided', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue(null);

    await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key', foursquareApiKey: 'fsq3-key' },
    );

    expect(searchFoursquareVenues).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'Brooklyn, NY', apiKey: 'fsq3-key' }),
    );
    expect(enrichVenuesWithFoursquareData).toHaveBeenCalled();
  });

  test('skips Foursquare enrichment when no foursquareApiKey is provided', async () => {
    searchPlaces.mockResolvedValue([]);

    await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key' },
    );

    expect(searchFoursquareVenues).not.toHaveBeenCalled();
  });

  test('continues gracefully when OSM enrichment fails', async () => {
    searchPlaces.mockResolvedValue([PLACE_WITH_FB]);
    resolveFacebookUrl.mockResolvedValue(null);
    searchOsmVenues.mockRejectedValue(new Error('Overpass timeout'));

    const venues = await runHybridPipeline(
      { location: 'Brooklyn, NY' },
      { googlePlacesApiKey: 'gp-key' },
    );

    expect(venues).toHaveLength(1);
  });
});
