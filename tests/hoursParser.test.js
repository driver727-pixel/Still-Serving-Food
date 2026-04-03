'use strict';

const {
  parseTime,
  parseHours,
  isCurrentlyServing,
  formatTime,
  expandDayRange,
  detect24Hours,
  computeLocalNow,
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

  test('parses weekdays keyword', () => {
    const blocks = parseHours('Food hours: Weekdays 11am-9pm');
    expect(blocks.length).toBe(5); // Mon–Fri
    expect(blocks.map((b) => b.day)).toEqual([1, 2, 3, 4, 5]);
  });

  test('parses weekends keyword', () => {
    const blocks = parseHours('Kitchen: Weekends 10am-8pm');
    expect(blocks.length).toBe(2); // Sun + Sat
    expect(blocks.map((b) => b.day).sort()).toEqual([0, 6]);
  });

  test('parses comma-separated days', () => {
    const blocks = parseHours('Grill: Mon, Wed, Fri 12pm-9pm');
    expect(blocks.length).toBe(3);
    expect(blocks.map((b) => b.day)).toEqual([1, 3, 5]);
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

  test('wrap-around midnight: still serving early next morning', () => {
    // Friday block closes at 2am — should still be active at Saturday 1am
    const lateBlocks = [{ day: 5, open: 18 * 60, close: 2 * 60, label: 'friday', inFoodSection: true }];
    const satEarlyMorning = makeDate(6, 1); // Saturday 1am
    const result = isCurrentlyServing(lateBlocks, satEarlyMorning);
    expect(result.serving).toBe(true);
    expect(result.closesAt).toBe(2 * 60);
  });

  test('wrap-around midnight: not serving after close on next morning', () => {
    // Friday block closes at 2am — should not be active at Saturday 3am
    const lateBlocks = [{ day: 5, open: 18 * 60, close: 2 * 60, label: 'friday', inFoodSection: true }];
    const satMorning = makeDate(6, 3); // Saturday 3am
    const result = isCurrentlyServing(lateBlocks, satMorning);
    expect(result.serving).toBe(false);
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

// ---------------------------------------------------------------------------
// detect24Hours
// ---------------------------------------------------------------------------
describe('detect24Hours', () => {
  test('detects "open 24 hours"', () => {
    expect(detect24Hours('We are open 24 hours a day.')).toBe(true);
    expect(detect24Hours('Open 24 hours!')).toBe(true);
  });

  test('detects "24/7"', () => {
    expect(detect24Hours('We serve food 24/7.')).toBe(true);
  });

  test('detects "24-hour"', () => {
    expect(detect24Hours('Visit our 24-hour diner anytime.')).toBe(true);
  });

  test('detects "always open"', () => {
    expect(detect24Hours('We are always open for you.')).toBe(true);
  });

  test('detects "open around the clock"', () => {
    expect(detect24Hours('Hot food available open around the clock.')).toBe(true);
  });

  test('detects "never closes"', () => {
    expect(detect24Hours('This location never closes.')).toBe(true);
  });

  test('returns false for normal restaurant text', () => {
    expect(detect24Hours('Mon-Fri 12pm-9pm')).toBe(false);
    expect(detect24Hours('Kitchen hours: 11am to 10pm')).toBe(false);
  });

  test('returns false for empty or null input', () => {
    expect(detect24Hours('')).toBe(false);
    expect(detect24Hours(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseHours — hint patterns (opening, closing, combined)
// ---------------------------------------------------------------------------
describe('parseHours hint patterns', () => {
  // ----- closing-only hints -----
  test('parses "food until 10pm" as daily hint blocks', () => {
    const blocks = parseHours('food until 10pm');
    expect(blocks.length).toBe(7); // one per day
    expect(blocks[0].close).toBe(22 * 60);
    expect(blocks[0].fromHint).toBe(true);
    expect(blocks[0].inFoodSection).toBe(true);
  });

  test('parses "kitchen closes at 9pm" as daily hint blocks', () => {
    const blocks = parseHours('kitchen closes at 9pm');
    expect(blocks.length).toBe(7);
    expect(blocks[0].close).toBe(21 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('parses "serving until midnight" as daily hint blocks', () => {
    const blocks = parseHours('serving until midnight');
    const closes = blocks.map((b) => b.close);
    expect(closes.every((c) => c === 24 * 60)).toBe(true);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('closing-only hint defaults open to 11:00 AM', () => {
    const blocks = parseHours('grill closes at 10pm');
    expect(blocks[0].open).toBe(11 * 60);
  });

  // ----- opening-only hints -----
  test('parses "kitchen opens at 9am" as daily hint blocks', () => {
    const blocks = parseHours('kitchen opens at 9am');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(9 * 60);
    expect(blocks[0].fromHint).toBe(true);
    expect(blocks[0].inFoodSection).toBe(true);
  });

  test('parses "food from 9am" (no close) as daily hint blocks', () => {
    const blocks = parseHours('food from 9am');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(9 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('parses "serving starts at 11am" as daily hint blocks', () => {
    const blocks = parseHours('serving starts at 11am');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(11 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('opening-only hint defaults close to 10:00 PM', () => {
    const blocks = parseHours('kitchen opens at 9am');
    expect(blocks[0].close).toBe(22 * 60);
  });

  // ----- combined hint (open + close on same line) -----
  test('parses "food from 9am to 10pm" as daily hint blocks', () => {
    const blocks = parseHours('food from 9am to 10pm');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(9 * 60);
    expect(blocks[0].close).toBe(22 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('parses "kitchen open 11am-10pm" as daily hint blocks', () => {
    const blocks = parseHours('kitchen open 11am-10pm');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(11 * 60);
    expect(blocks[0].close).toBe(22 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('parses "grill hours: 9am-10pm" as daily hint blocks', () => {
    const blocks = parseHours('grill hours: 9am-10pm');
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(9 * 60);
    expect(blocks[0].close).toBe(22 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  // ----- cross-line pairing -----
  test('pairs opening and closing hints from separate lines', () => {
    const text = 'Kitchen opens at 9am\nFood until 10pm';
    const blocks = parseHours(text);
    expect(blocks.length).toBe(7);
    expect(blocks[0].open).toBe(9 * 60);
    expect(blocks[0].close).toBe(22 * 60);
    expect(blocks[0].fromHint).toBe(true);
  });

  test('uses earliest open hint when multiple opening hints exist', () => {
    const text = 'Food from 9am\nServing starts at 11am';
    const blocks = parseHours(text);
    expect(blocks[0].open).toBe(9 * 60); // min of 9am and 11am
  });

  test('uses latest close hint when multiple closing hints exist', () => {
    const text = 'Food until 9pm\nGrill closes at 10pm';
    const blocks = parseHours(text);
    expect(blocks[0].close).toBe(22 * 60); // max of 9pm and 10pm
  });

  // ----- priority over hints -----
  test('explicit blocks take priority over hints in isCurrentlyServing', () => {
    // Explicit block: Mon 12pm-9pm
    const explicit = { day: 1, open: 12 * 60, close: 21 * 60, label: 'monday', inFoodSection: true };
    // Hint block for every day closing at midnight
    const hint = { day: 1, open: 11 * 60, close: 24 * 60, label: 'monday', inFoodSection: true, fromHint: true };

    // At Monday 10pm (after explicit close, before hint close)
    const d = new Date();
    d.setDate(d.getDate() - d.getDay() + 1); // set to Monday
    d.setHours(22, 0, 0, 0);

    // With only the hint, should report serving (22:00 < 24:00)
    expect(isCurrentlyServing([hint], d).serving).toBe(true);
    // With both, explicit block wins and 22:00 is past 21:00 close → not serving
    expect(isCurrentlyServing([explicit, hint], d).serving).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeLocalNow
// ---------------------------------------------------------------------------
describe('computeLocalNow', () => {
  test('offset=0 returns approximately the same time as new Date()', () => {
    const before = Date.now();
    const result = computeLocalNow(0);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  test('positive offset advances the time by the given minutes', () => {
    // UTC+5 (300 minutes) should return a Date whose getHours() is 5 hours
    // ahead of what a UTC clock shows.
    const utcNow = new Date();
    const localNow = computeLocalNow(300);
    // The difference between the two Date objects' getTime() values reflects the
    // server-offset adjustment. What matters is that getHours() is offset by +5h.
    const utcHours = new Date(utcNow.getTime() + utcNow.getTimezoneOffset() * 60 * 1000).getHours();
    const localHours = localNow.getHours();
    expect((localHours - utcHours + 24) % 24).toBe(5);
  });

  test('negative offset retreats the time by the given minutes', () => {
    // UTC-5 (EST, -300 minutes) should return a Date 5 hours behind UTC.
    const utcNow = new Date();
    const localNow = computeLocalNow(-300);
    const utcHours = new Date(utcNow.getTime() + utcNow.getTimezoneOffset() * 60 * 1000).getHours();
    const localHours = localNow.getHours();
    expect((localHours - utcHours + 24) % 24).toBe(19); // 24 - 5 = 19
  });

  test('timezone-offset date produces correct isCurrentlyServing result', () => {
    // Simulate a server in UTC, user in EST (UTC-5).
    // It is 2 pm EST = 7 pm UTC (19:00).
    // A lunch-only restaurant open Mon-Fri 11am-3pm should show serving=true at 2pm EST.

    // Build a UTC date representing 19:00 UTC on a Monday (any Monday).
    const utcMonday19 = new Date();
    // Walk to the nearest Monday (stay on today if already Monday).
    const daysUntilMon = (1 - utcMonday19.getDay() + 7) % 7;
    utcMonday19.setDate(utcMonday19.getDate() + daysUntilMon);
    // Force the UTC clock to 19:00 UTC using setUTCHours so the test is
    // timezone-independent (the test runner may itself be in any timezone).
    utcMonday19.setUTCHours(19, 0, 0, 0);

    // Simulate the server being in UTC: computeLocalNow(-300) from that point.
    // We manually construct the adjusted Date using the same formula.
    const utcOffsetMinutes = -300; // EST
    const ms = utcMonday19.getTime() + (utcOffsetMinutes + utcMonday19.getTimezoneOffset()) * 60 * 1000;
    const localNow = new Date(ms);

    // Lunch-only block: Monday 11am-3pm
    const blocks = [{ day: 1, open: 11 * 60, close: 15 * 60, label: 'monday', inFoodSection: true }];

    // Without timezone adjustment: UTC 19:00 is outside 11-15 → false (broken behaviour)
    const wrongResult = isCurrentlyServing(blocks, utcMonday19);
    expect(wrongResult.serving).toBe(false); // 19:00 UTC is past 15:00 close

    // With timezone adjustment: local 14:00 is inside 11-15 → true (correct behaviour)
    const correctResult = isCurrentlyServing(blocks, localNow);
    expect(correctResult.serving).toBe(true);
  });
});
