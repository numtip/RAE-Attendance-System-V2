function snakeToCamel(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function formatDateOnly(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatDateTime(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const decimalKeys = new Set([
  'totalDays',
  'usedDays',
  'remainingDays',
  'workDuration',
  'totalWorkHours',
]);

function normalizeValue(camelKey, value) {
  if (value == null) return value;
  if (decimalKeys.has(camelKey) && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (camelKey === 'date' || camelKey === 'startDate' || camelKey === 'endDate' || camelKey === 'hireDate') {
    return formatDateOnly(value);
  }
  if (
    camelKey === 'checkIn'
    || camelKey === 'checkOut'
    || camelKey === 'lastLogin'
    || camelKey === 'lockedUntil'
    || camelKey === 'expiresAt'
    || camelKey === 'revokedAt'
    || camelKey === 'createdAt'
    || camelKey === 'updatedAt'
  ) {
    return formatDateTime(value);
  }
  if (typeof value === 'object' && typeof value.toString === 'function' && value.constructor?.name === 'Decimal') {
    return Number(value.toString());
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

function mapRow(row) {
  if (!row) return null;
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = snakeToCamel(key);
    mapped[camelKey] = normalizeValue(camelKey, value);
  }
  return mapped;
}

function mapRows(rows) {
  return rows.map(mapRow);
}

module.exports = { mapRow, mapRows };
