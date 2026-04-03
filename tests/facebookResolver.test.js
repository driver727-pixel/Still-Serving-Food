'use strict';

jest.mock('@mendable/firecrawl-js', () => {
  const mockScrape = jest.fn();
  return {
    default: jest.fn().mockImplementation(() => ({ scrape: mockScrape })),
    _mockScrape: mockScrape,
  };
});

const FirecrawlApp = require('@mendable/firecrawl-js');
const {
  resolveFacebookUrl, isFacebookUrl, normaliseFacebookUrl,
  resolveInstagramUrl, isInstagramUrl, normaliseInstagramUrl,
} = require('../functions/facebookResolver');

let mockScrape;

beforeEach(() => {
  jest.clearAllMocks();
  mockScrape = FirecrawlApp._mockScrape;
  FirecrawlApp.default.mockImplementation(() => ({ scrape: mockScrape }));
});

// ---------------------------------------------------------------------------
// isFacebookUrl
// ---------------------------------------------------------------------------
describe('isFacebookUrl', () => {
  test('recognises a simple page URL', () => {
    expect(isFacebookUrl('https://www.facebook.com/TheCrownBar')).toBe(true);
  });

  test('recognises without www', () => {
    expect(isFacebookUrl('https://facebook.com/myrestaurant')).toBe(true);
  });

  test('recognises pages with dots and dashes in the name', () => {
    expect(isFacebookUrl('https://www.facebook.com/the.crown.bar')).toBe(true);
  });

  test('rejects share dialog URLs', () => {
    expect(isFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=example.com')).toBe(false);
  });

  test('rejects login URLs', () => {
    expect(isFacebookUrl('https://www.facebook.com/login/')).toBe(false);
  });

  test('rejects group URLs', () => {
    expect(isFacebookUrl('https://www.facebook.com/groups/somegroup')).toBe(false);
  });

  test('rejects marketplace URLs', () => {
    expect(isFacebookUrl('https://www.facebook.com/marketplace')).toBe(false);
  });

  test('recognises numeric page IDs', () => {
    expect(isFacebookUrl('https://www.facebook.com/123456789')).toBe(true);
  });

  test('rejects non-Facebook URLs', () => {
    expect(isFacebookUrl('https://www.instagram.com/myrestaurant')).toBe(false);
    expect(isFacebookUrl('https://example.com')).toBe(false);
  });

  test('returns false for non-string input', () => {
    expect(isFacebookUrl(null)).toBe(false);
    expect(isFacebookUrl(undefined)).toBe(false);
    expect(isFacebookUrl(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normaliseFacebookUrl
// ---------------------------------------------------------------------------
describe('normaliseFacebookUrl', () => {
  test('strips query-string and trailing slash', () => {
    expect(normaliseFacebookUrl('https://www.facebook.com/TheCrown/?ref=bookmarks')).toBe(
      'https://www.facebook.com/TheCrown',
    );
  });

  test('normalises non-www to www', () => {
    expect(normaliseFacebookUrl('https://facebook.com/TheCrown')).toBe(
      'https://www.facebook.com/TheCrown',
    );
  });

  test('returns null for non-Facebook URLs', () => {
    expect(normaliseFacebookUrl('https://example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveFacebookUrl — fast path (website IS a Facebook URL)
// ---------------------------------------------------------------------------
describe('resolveFacebookUrl — fast path', () => {
  test('returns normalised FB URL when website is a Facebook page', async () => {
    const place = { website: 'https://www.facebook.com/TheCrown/' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBe('https://www.facebook.com/TheCrown');
    // Should not call Firecrawl
    expect(mockScrape).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveFacebookUrl — no website
// ---------------------------------------------------------------------------
describe('resolveFacebookUrl — no website', () => {
  test('returns null when place has no website', async () => {
    const result = await resolveFacebookUrl({ website: null }, 'fc-key');
    expect(result).toBeNull();
    expect(mockScrape).not.toHaveBeenCalled();
  });

  test('returns null when website is undefined', async () => {
    const result = await resolveFacebookUrl({}, 'fc-key');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveFacebookUrl — slow path (scrape homepage for FB links)
// ---------------------------------------------------------------------------
describe('resolveFacebookUrl — slow path', () => {
  test('extracts Facebook URL from scraped links array', async () => {
    mockScrape.mockResolvedValue({
      links: [
        'https://twitter.com/thecrown',
        'https://www.facebook.com/TheCrownBar',
        'https://instagram.com/thecrown',
      ],
      markdown: '',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBe('https://www.facebook.com/TheCrownBar');
  });

  test('extracts Facebook URL from link objects (url property)', async () => {
    mockScrape.mockResolvedValue({
      links: [
        { url: 'https://www.facebook.com/TheCrownBar', text: 'Facebook' },
      ],
      markdown: '',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBe('https://www.facebook.com/TheCrownBar');
  });

  test('falls back to scanning markdown when links array has no FB URL', async () => {
    mockScrape.mockResolvedValue({
      links: [],
      markdown:
        'Follow us on [Facebook](https://www.facebook.com/TheCrownMarkdown) for updates.',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBe('https://www.facebook.com/TheCrownMarkdown');
  });

  test('returns null when no Facebook URL is found anywhere', async () => {
    mockScrape.mockResolvedValue({
      links: ['https://twitter.com/thecrown'],
      markdown: 'No facebook link here.',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBeNull();
  });

  test('returns null and does not throw when Firecrawl scrape fails', async () => {
    mockScrape.mockRejectedValue(new Error('Firecrawl error'));

    const place = { website: 'https://thecrown.com' };
    await expect(resolveFacebookUrl(place, 'fc-key')).resolves.toBeNull();
  });

  test('does not return share-dialog URLs as Facebook page links', async () => {
    mockScrape.mockResolvedValue({
      links: ['https://www.facebook.com/sharer/sharer.php?u=thecrown.com'],
      markdown: '',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveFacebookUrl(place, 'fc-key');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isInstagramUrl
// ---------------------------------------------------------------------------
describe('isInstagramUrl', () => {
  test('recognises a profile page URL', () => {
    expect(isInstagramUrl('https://www.instagram.com/thecrownbar')).toBe(true);
  });

  test('recognises without www', () => {
    expect(isInstagramUrl('https://instagram.com/myrestaurant')).toBe(true);
  });

  test('recognises handles with dots and underscores', () => {
    expect(isInstagramUrl('https://www.instagram.com/the_crown.bar')).toBe(true);
  });

  test('rejects individual post URLs (/p/)', () => {
    expect(isInstagramUrl('https://www.instagram.com/p/ABC123/')).toBe(false);
  });

  test('rejects reels URLs', () => {
    expect(isInstagramUrl('https://www.instagram.com/reel/ABC123/')).toBe(false);
  });

  test('rejects stories URLs', () => {
    expect(isInstagramUrl('https://www.instagram.com/stories/thecrown/123/')).toBe(false);
  });

  test('rejects explore URLs', () => {
    expect(isInstagramUrl('https://www.instagram.com/explore/tags/food/')).toBe(false);
  });

  test('rejects accounts URLs', () => {
    expect(isInstagramUrl('https://www.instagram.com/accounts/login/')).toBe(false);
  });

  test('rejects non-Instagram URLs', () => {
    expect(isInstagramUrl('https://www.facebook.com/thecrownbar')).toBe(false);
    expect(isInstagramUrl('https://example.com')).toBe(false);
  });

  test('returns false for non-string input', () => {
    expect(isInstagramUrl(null)).toBe(false);
    expect(isInstagramUrl(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normaliseInstagramUrl
// ---------------------------------------------------------------------------
describe('normaliseInstagramUrl', () => {
  test('strips query-string and trailing slash', () => {
    expect(normaliseInstagramUrl('https://www.instagram.com/TheCrown/?hl=en')).toBe(
      'https://www.instagram.com/TheCrown',
    );
  });

  test('normalises non-www to www', () => {
    expect(normaliseInstagramUrl('https://instagram.com/TheCrown')).toBe(
      'https://www.instagram.com/TheCrown',
    );
  });

  test('returns null for non-Instagram profile URLs', () => {
    expect(normaliseInstagramUrl('https://example.com')).toBeNull();
  });

  test('returns null for post URLs', () => {
    expect(normaliseInstagramUrl('https://www.instagram.com/p/ABC123/')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveInstagramUrl — fast path (website IS an Instagram URL)
// ---------------------------------------------------------------------------
describe('resolveInstagramUrl — fast path', () => {
  test('returns normalised IG URL when website is an Instagram profile page', async () => {
    const place = { website: 'https://www.instagram.com/thecrownbar/' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBe('https://www.instagram.com/thecrownbar');
    expect(mockScrape).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveInstagramUrl — no website
// ---------------------------------------------------------------------------
describe('resolveInstagramUrl — no website', () => {
  test('returns null when place has no website', async () => {
    const result = await resolveInstagramUrl({ website: null }, 'fc-key');
    expect(result).toBeNull();
    expect(mockScrape).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveInstagramUrl — slow path (scrape homepage for IG links)
// ---------------------------------------------------------------------------
describe('resolveInstagramUrl — slow path', () => {
  test('extracts Instagram URL from scraped links array', async () => {
    mockScrape.mockResolvedValue({
      links: [
        'https://www.facebook.com/TheCrown',
        'https://www.instagram.com/thecrown',
      ],
      markdown: '',
    });

    const place = { website: 'https://thecrown.com' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBe('https://www.instagram.com/thecrown');
  });

  test('extracts Instagram URL from link objects (url property)', async () => {
    mockScrape.mockResolvedValue({
      links: [{ url: 'https://www.instagram.com/thecrown', text: 'Instagram' }],
      markdown: '',
    });
    const place = { website: 'https://thecrown.com' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBe('https://www.instagram.com/thecrown');
  });

  test('falls back to scanning markdown when links array has no IG URL', async () => {
    mockScrape.mockResolvedValue({
      links: [],
      markdown: 'Follow us on [Instagram](https://www.instagram.com/thecrown_ig) for updates.',
    });
    const place = { website: 'https://thecrown.com' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBe('https://www.instagram.com/thecrown_ig');
  });

  test('returns null when no Instagram URL is found', async () => {
    mockScrape.mockResolvedValue({
      links: ['https://twitter.com/thecrown'],
      markdown: 'No instagram link here.',
    });
    const place = { website: 'https://thecrown.com' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBeNull();
  });

  test('returns null and does not throw when Firecrawl scrape fails', async () => {
    mockScrape.mockRejectedValue(new Error('Firecrawl error'));
    const place = { website: 'https://thecrown.com' };
    await expect(resolveInstagramUrl(place, 'fc-key')).resolves.toBeNull();
  });

  test('does not return post URLs as Instagram profile links', async () => {
    mockScrape.mockResolvedValue({
      links: ['https://www.instagram.com/p/ABC123/'],
      markdown: '',
    });
    const place = { website: 'https://thecrown.com' };
    const result = await resolveInstagramUrl(place, 'fc-key');
    expect(result).toBeNull();
  });
});
