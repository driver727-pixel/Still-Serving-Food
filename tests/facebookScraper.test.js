'use strict';

jest.mock('@mendable/firecrawl-js', () => {
  const mockScrape = jest.fn();
  return {
    default: jest.fn().mockImplementation(() => ({ scrape: mockScrape })),
    _mockScrape: mockScrape,
  };
});

jest.mock('https');

const https = require('https');
const FirecrawlApp = require('@mendable/firecrawl-js');
const { scrapeFacebookPage } = require('../functions/facebookScraper');

let mockScrape;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.APIFY_API_KEY;
  mockScrape = FirecrawlApp._mockScrape;
  FirecrawlApp.default.mockImplementation(() => ({ scrape: mockScrape }));
});

// ---------------------------------------------------------------------------
// Firecrawl path
// ---------------------------------------------------------------------------
describe('scrapeFacebookPage — Firecrawl path', () => {
  test('returns parsed hours from About section text', async () => {
    mockScrape.mockResolvedValue({
      markdown: `
## About
Kitchen hours:
Mon-Fri 12pm-9pm
Sat 12pm-10pm
`,
    });

    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: 'fc-key',
    });

    expect(result.facebookUrl).toBe('https://www.facebook.com/TheCrown');
    expect(result.hourBlocks.length).toBeGreaterThan(0);
    expect(result.scraper).toBe('firecrawl');
    expect(result.hitLoginWall).toBe(false);
    expect(result.hoursSource).toMatch(/facebook_about/);
  });

  test('detects login wall and sets hitLoginWall to true', async () => {
    mockScrape.mockResolvedValue({
      markdown: 'Log in to Facebook to see more from TheCrown.',
    });

    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: 'fc-key',
    });

    expect(result.hitLoginWall).toBe(true);
    expect(result.aboutText).toBe('');
    expect(result.recentPosts).toEqual([]);
    expect(result.hourBlocks).toEqual([]);
    expect(result.callForHours).toBeUndefined(); // not set at this layer
  });

  test('returns empty result gracefully when Firecrawl throws', async () => {
    mockScrape.mockRejectedValue(new Error('Firecrawl timeout'));

    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: 'fc-key',
    });

    expect(result.hourBlocks).toEqual([]);
    expect(result.serving).toBe(false);
    expect(result.hitLoginWall).toBe(false);
  });

  test('detects 24-hour status', async () => {
    mockScrape.mockResolvedValue({
      markdown: 'About\nWe are open 24 hours, 7 days a week.',
    });

    const result = await scrapeFacebookPage('https://www.facebook.com/DinnersAllDay', {
      firecrawlApiKey: 'fc-key',
    });

    expect(result.is24Hours).toBe(true);
    expect(result.serving).toBe(true);
  });

  test('returns scraper=none when no API keys are provided', async () => {
    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: undefined,
      apifyApiKey: undefined,
    });

    expect(result.scraper).toBe('none');
    expect(result.hourBlocks).toEqual([]);
    expect(mockScrape).not.toHaveBeenCalled();
  });

  test('marks hoursSource as facebook_post when recent posts contain hours', async () => {
    mockScrape.mockResolvedValue({
      markdown: `
## About
We serve the best burgers in town.

Food until 11pm tonight.

Another short post.
`,
    });

    const result = await scrapeFacebookPage('https://www.facebook.com/BurgerPlace', {
      firecrawlApiKey: 'fc-key',
    });

    // "Food until 11pm tonight." matches CLOSING_HINT_RE in hoursParser and
    // appears as a standalone post block → hoursSource should be facebook_post
    expect(result.hoursSource).toBe('facebook_post');
  });
});

// ---------------------------------------------------------------------------
// Apify path
// ---------------------------------------------------------------------------

function mockApifySuccess(apifyApiKey, aboutText, posts) {
  const runBody = JSON.stringify({
    data: { defaultDatasetId: 'dataset_abc' },
  });
  const datasetBody = JSON.stringify([
    {
      about: aboutText,
      posts: posts.map((t) => ({ text: t })),
    },
  ]);

  let getCallCount = 0;
  https.get.mockImplementation((url, cb) => {
    getCallCount++;
    const body = datasetBody;
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

  https.request.mockImplementation((url, options, cb) => {
    const fakeRes = {
      on: (event, handler) => {
        if (event === 'data') handler(runBody);
        if (event === 'end') handler();
        return fakeRes;
      },
    };
    cb(fakeRes);
    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  });
}

describe('scrapeFacebookPage — Apify path', () => {
  beforeEach(() => {
    process.env.APIFY_API_KEY = 'apify-test-key';
  });

  afterEach(() => {
    delete process.env.APIFY_API_KEY;
  });

  test('uses Apify when APIFY_API_KEY is set', async () => {
    mockApifySuccess(
      'apify-test-key',
      'Kitchen hours: Mon-Fri 12pm-9pm',
      ['Closing early tonight at 8pm!'],
    );

    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: 'fc-key',
      apifyApiKey: 'apify-test-key',
    });

    expect(result.scraper).toBe('apify');
    expect(result.hourBlocks.length).toBeGreaterThan(0);
    expect(mockScrape).not.toHaveBeenCalled();
  });

  test('falls back to Firecrawl when Apify throws', async () => {
    https.request.mockImplementation(() => {
      const fakeReq = {
        on: jest.fn().mockImplementation((event, handler) => {
          if (event === 'error') handler(new Error('Apify unreachable'));
          return fakeReq;
        }),
        write: jest.fn(),
        end: jest.fn(),
      };
      return fakeReq;
    });

    mockScrape.mockResolvedValue({
      markdown: 'About\nKitchen open Mon-Fri 12pm-9pm.',
    });

    const result = await scrapeFacebookPage('https://www.facebook.com/TheCrown', {
      firecrawlApiKey: 'fc-key',
      apifyApiKey: 'apify-test-key',
    });

    expect(result.scraper).toBe('firecrawl');
    expect(mockScrape).toHaveBeenCalledTimes(1);
  });
});
