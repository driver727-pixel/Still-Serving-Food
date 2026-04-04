'use strict';

const {
  generateAffiliateLinks,
  buildDoorDashLink,
  buildUberEatsLink,
  buildResyLink,
  extractCityFromAddress,
} = require('../functions/affiliateLinks');

describe('affiliateLinks', () => {
  describe('buildDoorDashLink', () => {
    test('generates a DoorDash search URL', () => {
      const link = buildDoorDashLink('The Crown', '123 Main St');
      expect(link).toBe('https://www.doordash.com/search/store/The%20Crown%20123%20Main%20St/');
    });

    test('handles special characters', () => {
      const link = buildDoorDashLink('Joe\'s Bar & Grill', '456 Oak Ave');
      expect(link).toContain('doordash.com');
      expect(link).toContain(encodeURIComponent('Joe\'s Bar & Grill'));
    });
  });

  describe('buildUberEatsLink', () => {
    test('generates an UberEats search URL', () => {
      const link = buildUberEatsLink('Pizza Palace', '789 Elm St');
      expect(link).toBe('https://www.ubereats.com/search?q=Pizza%20Palace%20789%20Elm%20St');
    });
  });

  describe('buildResyLink', () => {
    test('generates a Resy search URL with city slug', () => {
      const link = buildResyLink('Fancy Restaurant', 'New York');
      expect(link).toBe('https://resy.com/cities/new-york?query=Fancy%20Restaurant');
    });

    test('handles empty city', () => {
      const link = buildResyLink('Fancy Restaurant', '');
      expect(link).toBe('https://resy.com/cities/?query=Fancy%20Restaurant');
    });
  });

  describe('extractCityFromAddress', () => {
    test('extracts city from standard address format', () => {
      const city = extractCityFromAddress('123 Main St, Brooklyn, NY 11201');
      expect(city).toBe('Brooklyn');
    });

    test('returns empty string for null/undefined', () => {
      expect(extractCityFromAddress(null)).toBe('');
      expect(extractCityFromAddress(undefined)).toBe('');
      expect(extractCityFromAddress('')).toBe('');
    });

    test('handles address without commas', () => {
      const city = extractCityFromAddress('123 Main St');
      expect(city).toBeDefined();
    });
  });

  describe('generateAffiliateLinks', () => {
    test('generates all link types for a complete venue', () => {
      const venue = {
        name: 'The Caribou Tavern',
        description: '456 Oak Ave, Brooklyn, NY 11201',
        city: 'Brooklyn',
      };
      const links = generateAffiliateLinks(venue);

      expect(links.delivery).toBeDefined();
      expect(links.delivery.doordash).toContain('doordash.com');
      expect(links.delivery.ubereats).toContain('ubereats.com');
      expect(links.reservation).toBeDefined();
      expect(links.reservation.resy).toContain('resy.com');
      expect(links.reservation.resy).toContain('brooklyn');
    });

    test('handles venue with minimal data', () => {
      const venue = { name: 'Test' };
      const links = generateAffiliateLinks(venue);

      expect(links.delivery.doordash).toContain('doordash.com');
      expect(links.delivery.ubereats).toContain('ubereats.com');
      expect(links.reservation.resy).toContain('resy.com');
    });

    test('handles venue with address instead of description', () => {
      const venue = { name: 'Test', address: '123 Main St, Austin, TX' };
      const links = generateAffiliateLinks(venue);

      expect(links.delivery.doordash).toContain('123%20Main%20St');
    });

    test('extracts city from address when city not provided', () => {
      const venue = {
        name: 'Test Place',
        description: '789 Elm St, Madison, WI 53703',
      };
      const links = generateAffiliateLinks(venue);

      expect(links.reservation.resy).toContain('madison');
    });
  });
});
