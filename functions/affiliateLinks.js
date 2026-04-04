'use strict';

/**
 * Affiliate Link Generator
 *
 * Generates delivery and reservation affiliate links for venues.
 * Monetizes high-intent traffic by embedding UberEats, DoorDash,
 * and Resy links into venue results.
 */

/**
 * Build a DoorDash search URL for a venue.
 * @param {string} name - Venue name
 * @param {string} address - Venue address
 * @returns {string}
 */
function buildDoorDashLink(name, address) {
  const query = encodeURIComponent(`${name} ${address}`);
  return `https://www.doordash.com/search/store/${query}/`;
}

/**
 * Build an UberEats search URL for a venue.
 * @param {string} name - Venue name
 * @param {string} address - Venue address
 * @returns {string}
 */
function buildUberEatsLink(name, address) {
  const query = encodeURIComponent(`${name} ${address}`);
  return `https://www.ubereats.com/search?q=${query}`;
}

/**
 * Build a Resy search URL for a venue.
 * @param {string} name - Venue name
 * @param {string} city - Venue city
 * @returns {string}
 */
function buildResyLink(name, city) {
  const query = encodeURIComponent(name);
  const citySlug = (city || '').toLowerCase().replace(/\s+/g, '-');
  return `https://resy.com/cities/${citySlug}?query=${query}`;
}

/**
 * Generate all affiliate links for a venue.
 *
 * @param {object} venue - Venue object with name, description (address), city
 * @returns {object} Affiliate links object
 */
function generateAffiliateLinks(venue) {
  const name = venue.name || '';
  const address = venue.description || venue.address || '';
  const city = venue.city || extractCityFromAddress(address);

  return {
    delivery: {
      doordash: buildDoorDashLink(name, address),
      ubereats: buildUberEatsLink(name, address)
    },
    reservation: {
      resy: buildResyLink(name, city)
    }
  };
}

/**
 * Best-effort city extraction from an address string.
 * @param {string} address
 * @returns {string}
 */
function extractCityFromAddress(address) {
  if (!address) return '';
  // Try to extract city from "123 Main St, City, ST 12345" format
  const parts = address.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    // Second-to-last part is typically the city
    return parts[parts.length - 2].replace(/\d+/g, '').trim();
  }
  return '';
}

module.exports = {
  generateAffiliateLinks,
  buildDoorDashLink,
  buildUberEatsLink,
  buildResyLink,
  extractCityFromAddress
};
