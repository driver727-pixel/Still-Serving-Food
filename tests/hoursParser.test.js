'use strict';

const {
  parseTime,
  parseHours,
  isCurrentlyServing,
  formatTime,
  expandDayRange,
} = require('../functions/hoursParser');

// ---------------------------------------------------------------------------
// parseTime
// ---------------------------------------------------------------------------
describe('parseTime', () => {
  test('parses 12-hour PM times', () => {
    expect(parseTime('9pm')).toBe(21 * 60);
    expect(parseTime('9:30pm')).toBe(21 * 60 + 30);
    expect(parseTime('12pm')).toBe(12 * 60);
  });

  test('parses 12-hour AM times', () => {
    expect(parseTime('12am')).toBe(0);
    expect(parseTime('1am')).toBe(60);
    expect(parseTime('11:00am')).toBe(11 * 60);
  });

  test('parses 24-hour times (no meridiem)', () => {
    expect(parseTime('23:00')).toBe(23 * 60);
    expect(parseTime('0')).toBe(0);
  });

  test('parses special keywords', () => {
    expect(parseTime('midnight')).toBe(24 * 60);
    expect(parseTime('noon')).toBe(12 * 60);
  });

  test('returns null for unparseable input', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(parseTime('close')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// expandDayRange
// ---------------------------------------------------------------------------
describe('expandDayRange', () => {
  test('expands mon-fri', () => {
    expect(expandDayRange('mon-fri')).toEqual([1, 2, 3, 4, 5]);
  });

  test('expands monday to thursday', () => {
    expect(expandDayRange('monday to thursday')).toEqual([1, 2, 3, 4]);
  });

  test('handles a single day', () => {
    expect(expandDayRange('saturday')).toEqual([6]);
    expect(expandDayRange('sun')).toEqual([0]);
  });

  test('returns empty array for unknown tokens', () => {
    expect(expandDayRange('holiday')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseHours
// ---------------------------------------------------------------------------
describe('parseHours', () => {
  test('returns empty array for empty input', () => {
    expect(parseHours('')).toEqual([]);
    expect(parseHours(null)).toEqual([]);
  });

  test('parses a simple "Mon-Fri 12pm-9pm" line', () => {
    const blocks = parseHours('Mon-Fri 12pm-9pm');
    expect(blocks.length).toBe(5); // Mon through Fri
    expect(blocks[0].open).toBe(12 * 60);
    expect(blocks[0].close).toBe(21 * 60);
  });

  test('parses daily hours', () => {
    const blocks = parseHours('Daily 11am-10pm');
    expect(blocks.length).toBe(7);
  });

  test('marks blocks as inFoodSection when preceded by a food keyword', () => {
    const text = 'Kitchen hours:\nMon-Sun 12pm-10pm';
    const blocks = parseHours(text);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].inFoodSection).toBe(true);
  });

  test('parses a realistic multi-line snippet', () => {
    const text = `
      Grill open:
      Monday to Friday 12:00 pm - 9:00 pm
      Saturday 12pm - 10pm
      Sunday 12pm - 8pm
    `;
    const blocks = parseHours(text);
    // 5 weekdays + Sat + Sun = 7
    expect(blocks.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// isCurrentlyServing
// ---------------------------------------------------------------------------
describe('isCurrentlyServing', () => {
  function makeDate(dayOfWeek, hours, minutes = 0) {
    // Returns a Date for a specific weekday+time in the current week
    const d = new Date();
    d.setDate(d.getDate() - d.getDay() + dayOfWeek);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  const mondayBlocks = [{ day: 1, open: 12 * 60, close: 21 * 60, label: 'monday', inFoodSection: true }];

  test('returns serving=true when inside open window', () => {
    const now = makeDate(1, 14); // Monday 2pm
    const result = isCurrentlyServing(mondayBlocks, now);
    expect(result.serving).toBe(true);
  });

  test('returns serving=false before opening', () => {
    const now = makeDate(1, 10); // Monday 10am
    const result = isCurrentlyServing(mondayBlocks, now);
    expect(result.serving).toBe(false);
    expect(result.opensAt).toBe(12 * 60);
  });

  test('returns serving=false after closing', () => {
    const now = makeDate(1, 22); // Monday 10pm
    const result = isCurrentlyServing(mondayBlocks, now);
    expect(result.serving).toBe(false);
  });

  test('returns serving=false with no blocks', () => {
    const result = isCurrentlyServing([]);
    expect(result.serving).toBe(false);
    expect(result.opensAt).toBeNull();
  });

  test('handles wrap-around midnight closing', () => {
    // Bar serves food until 2am (120 min past midnight)
    const lateBlocks = [{ day: 5, open: 18 * 60, close: 2 * 60, label: 'friday', inFoodSection: true }];
    const fridayNight = makeDate(5, 23); // Friday 11pm
    const result = isCurrentlyServing(lateBlocks, fridayNight);
    expect(result.serving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------
describe('formatTime', () => {
  test('formats noon correctly', () => {
    expect(formatTime(12 * 60)).toBe('12:00 PM');
  });

  test('formats midnight correctly', () => {
    expect(formatTime(0)).toBe('12:00 AM');
  });

  test('formats 9:30pm correctly', () => {
    expect(formatTime(21 * 60 + 30)).toBe('9:30 PM');
  });

  test('returns N/A for null', () => {
    expect(formatTime(null)).toBe('N/A');
  });

  test('handles times past 24:00 (next-day wrap)', () => {
    expect(formatTime(25 * 60)).toBe('1:00 AM');
  });
});
