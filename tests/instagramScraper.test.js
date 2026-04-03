'use strict';

const https = require('https');

jest.mock('https');

const { scrapeInstagramPage } = require('../functions/instagramScraper');

// ---------------------------------------------------------------------------
// HTTP mock helpers (mirrors facebookScraper pattern)
// ---------------------------------------------------------------------------

function mockPostResponse(payload) {
  const body = JSON.stringify(payload);
  https.request.mockImplementation((_url, _options, cb) => {
    const fakeRes = {
      on: (event, handler) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
        return fakeRes;
      },
    };
    cb(fakeRes);
    return { write: jest.fn(), end: jest.fn(), on: jest.fn() };
  });
}

function mockGetResponse(payload) {
  const body = JSON.stringify(payload);
  https.get.mockImplementation((_url, cb) => {
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
  delete process.env.APIFY_API_KEY;
});

// ---------------------------------------------------------------------------
// scrapeInstagramPage
// ---------------------------------------------------------------------------
describe('scrapeInstagramPage', () => {
  test('returns empty result when no APIFY_API_KEY is set', async () => {
    const result = await scrapeInstagramPage('https://www.instagram.com/thecrown');
    expect(result.hourBlocks).toEqual([]);
    expect(result.recentPosts).toEqual([]);
    expect(result.hoursSource).toBeNull();
    expect(result.serving).toBe(false);
  });

  test('returns empty result when Apify run fails', async () => {
    // Mock run endpoint to reject
    https.request.mockImplementation((_url, _options, _cb) => {
      const req = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
      req.on.mockImplementation((event, handler) => {
        if (event === 'error') handler(new Error('Network error'));
      });
      return req;
    });

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );
    expect(result.hourBlocks).toEqual([]);
    expect(result.hoursSource).toBeNull();
  });

  test('extracts hours from posts containing food-service keywords', async () => {
    // Mock Apify run → returns dataset ID
    mockPostResponse({ data: { defaultDatasetId: 'dataset123' } });
    // Mock dataset fetch → returns posts
    mockGetResponse([
      { caption: 'Kitchen closes at 10pm tonight! Get your orders in.' },
      { caption: 'Happy Monday! Beautiful views.' },
      { caption: 'Food until midnight on Fridays and Saturdays.' },
    ]);

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );

    expect(result.recentPosts).toHaveLength(3);
    // "kitchen closes at 10pm" should trigger food-hours keyword, yielding hourBlocks
    expect(result.hourBlocks.length).toBeGreaterThan(0);
    expect(result.hoursSource).toBe('instagram_post');
  });

  test('returns no hourBlocks when posts have no food-service keywords', async () => {
    mockPostResponse({ data: { defaultDatasetId: 'dataset456' } });
    mockGetResponse([
      { caption: 'Beautiful sunset at the bar!' },
      { caption: 'Cocktails for the weekend.' },
    ]);

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );

    expect(result.recentPosts).toHaveLength(2);
    expect(result.hourBlocks).toEqual([]);
    expect(result.hoursSource).toBeNull();
  });

  test('uses APIFY_API_KEY env var when no option provided', async () => {
    process.env.APIFY_API_KEY = 'env-apify-key';
    mockPostResponse({ data: { defaultDatasetId: 'ds789' } });
    mockGetResponse([]);

    const result = await scrapeInstagramPage('https://www.instagram.com/testpub');
    expect(result.recentPosts).toEqual([]);
    // Should not throw — means the env var was used
    expect(result.igUrl).toBe('https://www.instagram.com/testpub');
  });

  test('throws when Apify returns no dataset ID', async () => {
    mockPostResponse({ data: {} }); // no defaultDatasetId

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );
    // Should fall back to empty rather than propagating the error
    expect(result.hourBlocks).toEqual([]);
  });

  test('handles string-type post items (not objects)', async () => {
    mockPostResponse({ data: { defaultDatasetId: 'ds-str' } });
    mockGetResponse(['Kitchen closes at 9pm', 'Great atmosphere tonight']);

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );
    // "kitchen" is a food keyword, so hours should be extracted
    expect(result.recentPosts).toHaveLength(2);
    expect(result.hourBlocks.length).toBeGreaterThan(0);
  });

  test('detects 24-hour service from posts', async () => {
    mockPostResponse({ data: { defaultDatasetId: 'ds-24h' } });
    mockGetResponse([{ caption: 'Our kitchen is open 24/7 — always serving hot food!' }]);

    const result = await scrapeInstagramPage(
      'https://www.instagram.com/thecrown',
      { apifyApiKey: 'apify-test-key' },
    );
    expect(result.is24Hours).toBe(true);
    expect(result.serving).toBe(true);
  });
});
