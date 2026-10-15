/**
 * Effective-dated validity windows for `employee_identifier` rows (migration 020).
 *
 * Semantics
 *   * effective_from NULL means "no lower bound"; effective_to NULL means "still open / no upper bound".
 *   * A date D is inside the window when (effective_from IS NULL OR effective_from <= D)
 *     AND (effective_to IS NULL OR effective_to >= D). Both ends are inclusive: a window that starts and
 *     ends on D covers D.
 *   * A NULL `onDate` means "do not filter on dates" — it is the pre-migration behaviour, so callers that
 *     do not care about history (for example the SSO national-id lookup) keep resolving exactly as before.
 *
 * Why a window and not a history table: `employee_identifier` keeps its security-critical unique key
 * `(id_type, id_value)` and the migration-017 namespace triggers untouched, so one identifier value still
 * belongs to exactly one employee for its whole life. The window records when that ownership is valid; it
 * never allows a value to move silently to a second employee.
 *
 * Everything here is pure. No I/O, no database, no repository access.
 */
const { HttpError } = require('../utils/httpError');

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoFromLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Rejects 2026-02-31 style values that match the shape but are not real days. */
function isRealCalendarDate(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

/**
 * Accepts an ISO 'YYYY-MM-DD' string, a Date instance, or null/undefined/'' (which all mean "no bound").
 * Throws before any write, and never echoes the rejected value in the message.
 */
function normalizeValidityDate(value, fieldName = 'date') {
  if (value === undefined || value === null || value === '') return null;
  let iso = null;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) iso = isoFromLocalDate(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (isRealCalendarDate(trimmed)) iso = trimmed;
  }
  if (!iso) {
    throw new HttpError(400, 'IDENTIFIER_INVALID_EFFECTIVE_DATE', `${fieldName} must be an ISO date (YYYY-MM-DD)`);
  }
  return iso;
}

/** Inclusive-window check. `onDate === null` means "no date filter" and always passes. */
function isEffectiveOnDate(record, onDate) {
  if (onDate == null) return true;
  const from = record?.effectiveFrom ?? null;
  const to = record?.effectiveTo ?? null;
  if (from != null && from > onDate) return false;
  if (to != null && to < onDate) return false;
  return true;
}

/**
 * Why a mapping is or is not usable on a date. Used for diagnostics only; never returns the identifier value.
 * 'unbounded' = the row itself is open on both ends, 'effective' = the row applies (either because a window
 * contains the date, or because no date filter was requested), 'not_yet_effective' = starts later,
 * 'expired' = ended earlier.
 */
function describeValidity(record, onDate) {
  const from = record?.effectiveFrom ?? null;
  const to = record?.effectiveTo ?? null;
  if (from == null && to == null) return 'unbounded';
  if (onDate == null) return 'effective';
  if (from != null && from > onDate) return 'not_yet_effective';
  if (to != null && to < onDate) return 'expired';
  return 'effective';
}

/** Rejects effective_to earlier than effective_from. ISO dates compare correctly as strings. */
function assertValidWindow({ effectiveFrom = null, effectiveTo = null } = {}) {
  if (effectiveFrom != null && effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'IDENTIFIER_INVALID_EFFECTIVE_WINDOW', 'effective_to must not be earlier than effective_from');
  }
  return { effectiveFrom, effectiveTo };
}

/** Normalizes and validates a window in one call. */
function normalizeValidityWindow(input = {}) {
  const effectiveFrom = normalizeValidityDate(input.effectiveFrom, 'effective_from');
  const effectiveTo = normalizeValidityDate(input.effectiveTo, 'effective_to');
  return assertValidWindow({ effectiveFrom, effectiveTo });
}

module.exports = {
  normalizeValidityDate,
  normalizeValidityWindow,
  assertValidWindow,
  isEffectiveOnDate,
  describeValidity,
};
