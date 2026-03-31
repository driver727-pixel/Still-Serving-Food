'use strict';

const { buildVenue } = require('../functions/scraper');

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
});
