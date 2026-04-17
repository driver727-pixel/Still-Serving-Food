'use strict';

const { parseTime, expandDayRange, formatTime } = require('./hoursParser');

// Matches simple SMS time tokens like "10", "10:30", "10am", or "10:30 pm".
const TIME_TOKEN_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

function normalizePhone(phone) {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  // 10-digit US number — Twilio delivers these as E.164 with +1 prefix
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function parseExplicitTime(token) {
  const trimmed = token.trim().toLowerCase();
  const match = trimmed.match(TIME_TOKEN_RE);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2] || '0', 10);
  const meridiem = match[3] || null;

  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
    return (hour * 60) + minute;
  }

  if (hour > 23) return null;
  return (hour * 60) + minute;
}

function chooseNextOccurrence(token, now) {
  const explicitMinutes = parseExplicitTime(token);
  if (explicitMinutes === null) return null;

  const match = token.trim().toLowerCase().match(TIME_TOKEN_RE);
  const meridiem = match && match[3];

  let candidates = [explicitMinutes];
  if (!meridiem && explicitMinutes < 12 * 60) {
    candidates.push(explicitMinutes + (12 * 60));
  }

  const nowMinutes = (now.getHours() * 60) + now.getMinutes();

  let chosen = null;
  for (const candidate of candidates) {
    if (candidate > nowMinutes) {
      chosen = candidate;
      break;
    }
  }

  if (chosen === null) {
    chosen = candidates[candidates.length - 1];
  }

  const date = new Date(now);
  date.setHours(Math.floor(chosen / 60), chosen % 60, 0, 0);
  if (date <= now) {
    date.setDate(date.getDate() + 1);
  }

  return {
    date,
    minutes: chosen % (24 * 60),
  };
}

function parseScheduleCommand(message) {
  if (typeof message !== 'string' || !message.trim()) return null;

  const normalized = message.trim().replace(/\s+/g, ' ');
  const firstSpace = normalized.indexOf(' ');
  if (firstSpace === -1) return null;

  const dayRange = normalized.slice(0, firstSpace).trim();
  const instruction = normalized.slice(firstSpace + 1).trim();
  const dayIndexes = expandDayRange(dayRange);
  if (!dayIndexes.length) return null;

  if (/^closed$/i.test(instruction)) {
    return {
      type: 'schedule_update',
      raw: normalized,
      closedDays: dayIndexes,
      hourBlocks: [],
      scheduleLabel: `${dayRange.toUpperCase()} closed`,
    };
  }

  const separatorIndex = instruction.indexOf('-');
  if (separatorIndex === -1) return null;
  const openToken = instruction.slice(0, separatorIndex).trim();
  const closeToken = instruction.slice(separatorIndex + 1).trim();
  if (!openToken || !closeToken) return null;
  const openMinutes = parseTime(openToken);
  let closeMinutes = parseTime(closeToken);
  if (openMinutes == null || closeMinutes == null) return null;

  const closeHasMeridiem = /\b(?:am|pm)\b/i.test(closeToken);
  if (!closeHasMeridiem && closeMinutes <= openMinutes && closeMinutes < 12 * 60) {
    closeMinutes += 12 * 60;
  }

  const hourBlocks = dayIndexes.map((day) => ({
    day,
    open: openMinutes,
    close: closeMinutes,
    label: dayRange.toUpperCase(),
    inFoodSection: true,
  }));

  return {
    type: 'schedule_update',
    raw: normalized,
    closedDays: [],
    hourBlocks,
    scheduleLabel: `${dayRange.toUpperCase()} ${formatTime(openMinutes)}-${formatTime(closeMinutes)}`,
  };
}

function parseOwnerTextCommand(message, now = new Date()) {
  if (typeof message !== 'string' || !message.trim()) {
    return null;
  }
  if (message.length > 160) {
    return null;
  }

  const scheduleUpdate = parseScheduleCommand(message);
  if (scheduleUpdate) {
    return scheduleUpdate;
  }

  const normalized = message.trim().replace(/\s+/g, ' ');
  const upper = normalized.toUpperCase();

  const openMatch = upper.match(/^OPEN(?: UNTIL)? (.+)$/);
  if (openMatch) {
    const parsed = chooseNextOccurrence(openMatch[1], now);
    if (!parsed) return null;
    return {
      type: 'open_until',
      raw: normalized,
      closeAt: parsed.date,
      closeMinutes: parsed.minutes,
    };
  }

  const closedMatch = upper.match(/^CLOSED(?: NOW)?$/);
  if (closedMatch) {
    return {
      type: 'closed_until',
      raw: normalized,
      reopenAt: null,
    };
  }

  const reopenMatch = upper.match(/^(?:REOPEN|REOPEN AT|CLOSED UNTIL) (.+)$/);
  if (reopenMatch) {
    const parsed = chooseNextOccurrence(reopenMatch[1], now);
    if (!parsed) return null;
    return {
      type: 'closed_until',
      raw: normalized,
      reopenAt: parsed.date,
    };
  }

  return null;
}

module.exports = {
  normalizePhone,
  parseScheduleCommand,
  parseOwnerTextCommand,
};
