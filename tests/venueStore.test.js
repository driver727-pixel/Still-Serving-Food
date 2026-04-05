'use strict';

const { get, set, clear } = require('../functions/venueStore');

describe('venueStore', () => {
  beforeEach(() => clear());

  test('returns null for unknown location', () => {
    expect(get('London')).toBeNull();
  });

  test('stores and retrieves venues', () => {
    const venues = [{ name: 'The Anchor', serving: true }];
    set('London', venues);
    expect(get('London')).toEqual(venues);
  });

  test('is case-insensitive for location keys', () => {
    const venues = [{ name: 'Bar One' }];
    set('LONDON', venues);
    expect(get('london')).toEqual(venues);
  });

  test('normalises commas so "Winona, Minnesota" hits the same cache as "Winona Minnesota"', () => {
    const venues = [{ name: 'The Anchor', serving: true }];
    set('Winona, Minnesota', venues);
    expect(get('Winona Minnesota')).toEqual(venues);
  });

  test('collapses extra internal whitespace in cache keys', () => {
    const venues = [{ name: 'Café Nord' }];
    set('Saint  Paul', venues);
    expect(get('Saint Paul')).toEqual(venues);
  });

  test('returns null after TTL expires', () => {
    jest.useFakeTimers();
    const venues = [{ name: 'Test Bar' }];
    set('paris', venues);
    jest.advanceTimersByTime(11 * 60 * 1000); // 11 minutes
    expect(get('paris')).toBeNull();
    jest.useRealTimers();
  });
});
