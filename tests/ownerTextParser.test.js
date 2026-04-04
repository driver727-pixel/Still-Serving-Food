'use strict';

const { normalizePhone, parseOwnerTextCommand } = require('../functions/ownerTextParser');

describe('ownerTextParser', () => {
  test('normalizes a phone number to +E164-ish format', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+5551234567');
    expect(normalizePhone('abc')).toBeNull();
  });

  test('parses OPEN commands into an open_until action', () => {
    const now = new Date('2026-04-04T17:00:00Z');
    const parsed = parseOwnerTextCommand('OPEN 10', now);

    expect(parsed).toMatchObject({ type: 'open_until', closeMinutes: 1320 });
    expect(parsed.closeAt.toISOString()).toBe('2026-04-04T22:00:00.000Z');
  });

  test('parses REOPEN commands into a closed_until action', () => {
    const now = new Date('2026-04-04T17:00:00Z');
    const parsed = parseOwnerTextCommand('REOPEN 6', now);

    expect(parsed).toMatchObject({ type: 'closed_until' });
    expect(parsed.reopenAt.toISOString()).toBe('2026-04-04T18:00:00.000Z');
  });

  test('rejects unsupported commands', () => {
    expect(parseOwnerTextCommand('MON-FRI 11-9')).toBeNull();
  });
});
