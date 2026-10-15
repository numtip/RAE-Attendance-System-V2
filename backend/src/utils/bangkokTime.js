/**
 * Store CHECKTIME as naive DATETIME in Asia/Bangkok wall time (no Buddhist year conversion).
 */

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatBangkokWall(date) {
  const bkk = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return [
    bkk.getUTCFullYear(),
    pad2(bkk.getUTCMonth() + 1),
    pad2(bkk.getUTCDate()),
  ].join('-').concat(
    ' ',
    [pad2(bkk.getUTCHours()), pad2(bkk.getUTCMinutes()), pad2(bkk.getUTCSeconds())].join(':'),
  );
}

function normalizeCheckTimeBangkok(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatBangkokWall(value);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) {
    return text.replace('T', ' ').slice(0, 19);
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return formatBangkokWall(new Date(parsed));
}

/**
 * 'YYYY-MM-DD' of a stored naive Asia/Bangkok wall timestamp.
 *
 * The same stored value can reach us two ways and both must yield the SAME calendar day:
 *   * a string, exactly as normalizeCheckTimeBangkok wrote it ('YYYY-MM-DD HH:MM:SS');
 *   * a Date, because mysql2 parses a DATETIME and the pool sets timezone 'Z', so the naive wall time
 *     round-trips through UTC. Taking the UTC day is therefore correct; adding the +7h offset here (as
 *     formatBangkokWall does) would move the date.
 * Returns null when the value cannot be interpreted, so the caller can decide instead of guessing.
 */
function wallDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

module.exports = { normalizeCheckTimeBangkok, formatBangkokWall, wallDateOnly };
