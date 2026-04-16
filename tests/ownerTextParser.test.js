'use strict';

const { normalizePhone, parseOwnerTextCommand, parseScheduleCommand } = require('../functions/ownerTextParser');

describe('ownerTextParser', () => {
  test('normalizes a phone number to E.164 format', () => {
    // 10-digit US number gets +1 country code (matches Twilio E.164 delivery format)
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    // Number already includes country code digit
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
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

  test('parses weekly schedule commands', () => {
    const parsed = parseScheduleCommand('MON-FRI 11-9');

    expect(parsed).toMatchObject({
      type: 'schedule_update',
      closedDays: [],
      scheduleLabel: 'MON-FRI 11:00 AM-9:00 PM',
    });
    expect(parsed.hourBlocks).toHaveLength(5);
    expect(parsed.hourBlocks[0]).toMatchObject({ day: 1, open: 660, close: 1260 });
    expect(parsed.hourBlocks[4]).toMatchObject({ day: 5, open: 660, close: 1260 });
  });

  test('parses closed-day schedule commands', () => {
    const parsed = parseOwnerTextCommand('SUN CLOSED');

    expect(parsed).toMatchObject({
      type: 'schedule_update',
      closedDays: [0],
      hourBlocks: [],
      scheduleLabel: 'SUN closed',
    });
  });

  test('rejects unsupported commands', () => {
    expect(parseOwnerTextCommand('DELAY 30')).toBeNull();
  });
});
