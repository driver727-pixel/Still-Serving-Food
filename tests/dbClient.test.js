'use strict';

const { minutesToTime } = require('../functions/dbClient');

describe('dbClient', () => {
  describe('minutesToTime', () => {
    test('converts 0 to 00:00', () => {
      expect(minutesToTime(0)).toBe('00:00');
    });

    test('converts 720 to 12:00', () => {
      expect(minutesToTime(720)).toBe('12:00');
    });

    test('converts 1320 to 22:00', () => {
      expect(minutesToTime(1320)).toBe('22:00');
    });

    test('converts 1440 to 24:00', () => {
      expect(minutesToTime(1440)).toBe('24:00');
    });

    test('handles NaN by returning 00:00', () => {
      expect(minutesToTime(NaN)).toBe('00:00');
    });

    test('handles undefined by returning 00:00', () => {
      expect(minutesToTime(undefined)).toBe('00:00');
    });

    test('clamps negative to 00:00', () => {
      expect(minutesToTime(-10)).toBe('00:00');
    });

    test('clamps above 1440 to 24:00', () => {
      expect(minutesToTime(2000)).toBe('24:00');
    });

    test('formats with leading zeros', () => {
      expect(minutesToTime(65)).toBe('01:05');
    });
  });

  describe('initDb', () => {
    const dbClient = require('../functions/dbClient');

    test('returns false when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      // initDb returns false when no URL is set
      expect(dbClient.isDbAvailable()).toBe(false);
    });
  });
});
