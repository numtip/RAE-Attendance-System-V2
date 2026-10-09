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

module.exports = { normalizeCheckTimeBangkok, formatBangkokWall };
