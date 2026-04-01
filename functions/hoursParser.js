'use strict';

/**
 * hoursParser.js
 *
 * Parses food-service / grill hours from free-form text scraped off restaurant
 * and bar websites.  Returns a structured array of daily hour ranges that can
 * be compared against the current time to decide whether food is being served
 * right now.
 */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const DAY_ALIASES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/**
 * Keywords that indicate a section is about food service rather than general
 * opening or drinks-only hours.
 */
const FOOD_SECTION_KEYWORDS = [
  'grill', 'kitchen', 'food', 'dining', 'lunch', 'dinner', 'breakfast',
  'brunch', 'menu', 'serving', 'hot food', 'last orders food',
];

/**
 * Convert a 12-hour time string ("11:30 pm", "2am", "midnight") into minutes
 * since midnight.
 * @param {string} raw
 * @returns {number|null} minutes since midnight, or null if unparseable
 */
function parseTime(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();

  if (s === 'midnight') return 24 * 60;
  if (s === 'noon') return 12 * 60;
  if (s === 'close' || s === 'closing') return null; // handled by caller

  // "11:30 pm", "11pm", "23:00", "2300"
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  // Allow 24:xx to represent midnight/next-day close times
  return hours * 60 + minutes;
}

/**
 * Expand a day range ("mon-fri", "monday to thursday") into an array of
 * day indices.
 * @param {string} raw
 * @returns {number[]}
 */
function expandDayRange(raw) {
  const s = raw.toLowerCase().trim();
  const rangeSep = /\s*(?:–|-|to)\s*/;
  const parts = s.split(rangeSep);

  if (parts.length === 2) {
    const start = DAY_ALIASES[parts[0].trim()];
    const end = DAY_ALIASES[parts[1].trim()];
    if (start == null || end == null) return [];
    const result = [];
    for (let d = start; d <= end; d++) result.push(d);
    // Handle week wrap (e.g. Fri–Sun)
    if (start > end) {
      for (let d = start; d <= 6; d++) result.push(d);
      for (let d = 0; d <= end; d++) result.push(d);
    }
    return result;
  }

  const single = DAY_ALIASES[s];
  return single != null ? [single] : [];
}

/**
 * Extract all food-relevant hour blocks from a block of text.
 *
 * @param {string} text - Raw text scraped from a venue page
 * @returns {Array<{day: number, open: number, close: number, label: string}>}
 *   day = 0-6 (Sun-Sat), open/close = minutes since midnight
 */
function parseHours(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const results = [];

  // We track whether we are inside a food-service section
  let inFoodSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const lower = line.toLowerCase();

    // Check if this line opens a food-relevant section
    if (FOOD_SECTION_KEYWORDS.some((kw) => lower.includes(kw))) {
      inFoodSection = true;
    }

    // Match patterns like:
    //   "Mon–Fri 12pm – 9pm"
    //   "Monday to Thursday: 11:30 am - 10:00 pm"
    //   "Sat, Sun 10am-3pm"
    //   "Daily 12pm-10pm"
    const hourPattern =
      /\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*(?:–|-|to)\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)?(?:\s*[,&]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*|daily|weekdays|weekends)\b[:\s]+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:–|-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|midnight|noon)/gi;

    let match;
    while ((match = hourPattern.exec(line)) !== null) {
      const dayStr = match[1];
      const openStr = match[2];
      const closeStr = match[3];

      const open = parseTime(openStr);
      const close = parseTime(closeStr);
      if (open == null || close == null) continue;

      let dayIndices;
      const dl = dayStr.toLowerCase();
      if (dl === 'daily') {
        dayIndices = [0, 1, 2, 3, 4, 5, 6];
      } else if (dl === 'weekdays') {
        dayIndices = [1, 2, 3, 4, 5];
      } else if (dl === 'weekends') {
        dayIndices = [0, 6];
      } else {
        // Handle comma-separated lists and ranges
        dayIndices = [];
        const segments = dayStr.split(/\s*[,&]\s*/);
        for (const seg of segments) {
          dayIndices.push(...expandDayRange(seg));
        }
      }

      for (const day of dayIndices) {
        results.push({
          day,
          open,
          close,
          label: DAYS[day],
          inFoodSection,
        });
      }
    }
  }

  return results;
}

/**
 * Given a set of parsed hour blocks, determine whether food is currently being
 * served.
 *
 * @param {ReturnType<typeof parseHours>} hourBlocks
 * @param {Date} [now] - Defaults to the current system time
 * @returns {{ serving: boolean, opensAt: number|null, closesAt: number|null }}
 */
function isCurrentlyServing(hourBlocks, now = new Date()) {
  const dayOfWeek = now.getDay(); // 0=Sun … 6=Sat
  const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();

  // Prefer food-section blocks; fall back to general blocks if none found
  const foodBlocks = hourBlocks.filter((b) => b.inFoodSection);
  const blocks = foodBlocks.length ? foodBlocks : hourBlocks;

  const todayBlocks = blocks.filter((b) => b.day === dayOfWeek);

  // Include previous day's wrap-past-midnight blocks so that e.g. a Friday
  // block open until 2am is still considered active on Saturday at 1am.
  const prevDay = (dayOfWeek + 6) % 7;
  const prevDayWrapBlocks = blocks.filter(
    (b) => b.day === prevDay && b.close <= b.open,
  );

  const relevantBlocks = [...todayBlocks, ...prevDayWrapBlocks];

  if (!relevantBlocks.length) {
    return { serving: false, opensAt: null, closesAt: null };
  }

  for (const block of relevantBlocks) {
    const { open, close } = block;
    // Closing times past midnight (e.g. 1am = 60 min) but stored as < open
    // are common in bar contexts — treat them as next-day.
    const wrapsNextDay = close <= open;

    const isServing = wrapsNextDay
      ? minutesSinceMidnight >= open || minutesSinceMidnight < close
      : minutesSinceMidnight >= open && minutesSinceMidnight < close;

    if (isServing) {
      return { serving: true, opensAt: open, closesAt: close };
    }
  }

  // Not currently serving — find next open time (today's blocks only)
  const upcoming = todayBlocks.filter((b) => b.open > minutesSinceMidnight);
  const opensAt = upcoming.length ? Math.min(...upcoming.map((b) => b.open)) : null;

  return { serving: false, opensAt, closesAt: null };
}

/**
 * Format minutes-since-midnight back to a human-readable "h:mm AM/PM" string.
 * @param {number|null} minutes
 * @returns {string}
 */
function formatTime(minutes) {
  if (minutes == null) return 'N/A';
  if (minutes >= 24 * 60) minutes -= 24 * 60;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

module.exports = { parseHours, isCurrentlyServing, formatTime, parseTime, expandDayRange };
