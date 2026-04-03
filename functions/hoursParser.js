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
  'delivery', 'pickup', 'take-out', 'takeout', 'carry-out', 'carryout',
  'to go', 'drive-thru', 'seating', 'taking orders', 'grill hours',
  'food hours', 'serving hours', 'hot food hours', 'delivery hours',
  'pickup hours',
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
 * Detect whether the text indicates 24-hour food service.
 * Matches common phrases found on Yelp, Facebook, and restaurant websites.
 *
 * @param {string} text
 * @returns {boolean}
 */
function detect24Hours(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return (
    /\bopen\s+24\s*(?:hours?|hrs?)\b/.test(lower) ||
    /\b24\s*(?:hours?|hrs?)\s+a\s+day\b/.test(lower) ||
    /\b24\/7\b/.test(lower) ||
    /\b24-hour\b/.test(lower) ||
    /\balways\s+open\b/.test(lower) ||
    /\bopen\s+around\s+the\s+clock\b/.test(lower) ||
    /\bnever\s+close[sd]?\b/.test(lower)
  );
}

/**
 * Extract all food-relevant hour blocks from a block of text.
 *
 * @param {string} text - Raw text scraped from a venue page
 * @returns {Array<{day: number, open: number, close: number, label: string, inFoodSection: boolean, fromClosingHint?: boolean}>}
 *   day = 0-6 (Sun-Sat), open/close = minutes since midnight.
 *   fromClosingHint=true means the block was inferred from a "food until X" / "kitchen closes at X"
 *   phrase where no explicit open time was stated; open defaults to 11:00 AM.
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

    // Detect phrases like "food until 10pm", "kitchen closes at 9", "serving until 2am",
    // "seating until midnight", "grill closes at 10", "taking orders until 9pm".
    // These provide a close time but no explicit open time; assume 11:00 AM as a
    // reasonable kitchen-open default so isCurrentlyServing can still use them.
    const closingHintRe =
      /\b(?:grill|kitchen|food|hot\s+food|dining|serving|seating|taking\s+orders?|last\s+(?:food\s+)?orders?)\s+(?:close[sd]?\s+at|(?:is\s+)?(?:available\s+)?until|'?til|till|ends?\s+at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|midnight|noon)/gi;

    let hint;
    while ((hint = closingHintRe.exec(line)) !== null) {
      const close = parseTime(hint[1]);
      if (close == null) continue;

      inFoodSection = true; // These lines are definitively about food service

      // Apply as a daily block — the phrase doesn't specify particular days
      for (let day = 0; day <= 6; day++) {
        results.push({
          day,
          open: 11 * 60, // Reasonable default: assume kitchen opens at 11 AM
          close,
          label: DAYS[day],
          inFoodSection: true,
          fromClosingHint: true,
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

  // Prefer food-section blocks; fall back to general blocks if none found.
  // Closing-hint blocks (inferred from "food until X" phrases) are only used
  // when no explicit hour ranges were found, to avoid overriding more accurate data.
  const explicitFoodBlocks = hourBlocks.filter((b) => b.inFoodSection && !b.fromClosingHint);
  const allExplicit = hourBlocks.filter((b) => !b.fromClosingHint);
  const closingHints = hourBlocks.filter((b) => b.fromClosingHint);

  let blocks;
  if (explicitFoodBlocks.length) {
    blocks = explicitFoodBlocks;
  } else if (allExplicit.length) {
    blocks = allExplicit;
  } else {
    blocks = closingHints;
  }

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

module.exports = { parseHours, isCurrentlyServing, formatTime, parseTime, expandDayRange, detect24Hours };
