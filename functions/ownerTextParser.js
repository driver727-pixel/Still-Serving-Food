'use strict';

function normalizePhone(phone) {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function parseExplicitTime(token) {
  const trimmed = token.trim().toLowerCase();
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2] || '0', 10);
  const meridiem = match[3] || null;

  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
    return (hour * 60) + minute;
  }

  if (hour > 23) return null;
  return (hour * 60) + minute;
}

function chooseNextOccurrence(token, now) {
  const explicitMinutes = parseExplicitTime(token);
  if (explicitMinutes === null) return null;

  const match = token.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
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
  date.setSeconds(0, 0);
  date.setHours(Math.floor(chosen / 60), chosen % 60, 0, 0);
  if (date <= now) {
    date.setDate(date.getDate() + 1);
  }

  return {
    date,
    minutes: chosen % (24 * 60),
  };
}

function parseOwnerTextCommand(message, now = new Date()) {
  if (typeof message !== 'string' || !message.trim()) {
    return null;
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
  parseOwnerTextCommand,
};
