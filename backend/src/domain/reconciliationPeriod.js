/**
 * Fiscal-year reporting period for R-04 reconciliation. PURE: no I/O, no database, no clock.
 *
 * A Thai government FISCAL YEAR (ปีงบประมาณ) `Y` (Buddhist Era) runs 1 October (Y-544 CE) to
 * 30 September (Y-543 CE). So fiscalYear 2569 -> 2025-10-01 .. 2026-09-30.
 *
 * This is deliberately a SEPARATE convention from the R-02 attendance report's Thai ACADEMIC year
 * (1 June - 31 May), which lives in `attendanceReport.js` as ACADEMIC_YEAR_START_MONTH = 6. The two
 * windows are not the same length and do not share boundaries, so this module must never import or
 * reuse the academic helper for a fiscal period (a test proves the two windows differ for the same year).
 *
 * REPORTING CONVENTION NEEDING OWNER CONFIRMATION: the repository has never had a fiscal period before
 * (the same treatment P-05/P-06 get). Before a real FY2569 source exists, the owner must confirm that
 * "fiscal year" here means the government Oct-Sep window and not, for example, the RAE internal accounting
 * year. Every snapshot names the exact Gregorian window it used so a reader never has to assume.
 *
 * Year bounds: the Gregorian span of the fiscal year must fall inside 2000..2100 (so the BE year is
 * ~2544..2644). A Buddhist-Era year is accepted because that is how the period is named on the route.
 */
const { HttpError } = require('../utils/httpError');

/** Thai fiscal years start in October (1-based month). Not the academic-year start (6). */
const FISCAL_YEAR_START_MONTH = 10;

/** CE year the fiscal year with BE number `beYear` starts in: BE = CE + 543 generally; the start is +544. */
const BE_FISCAL_START_OFFSET = 544;

const MIN_GREGORIAN_YEAR = 2000;
const MAX_GREGORIAN_YEAR = 2100;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalidPeriod(message) {
  return new HttpError(400, 'RECONCILIATION_INVALID_PERIOD', message);
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

/** Normalizes 'YYYY-MM-DD' (or a Date) to an ISO day, or throws RECONCILIATION_INVALID_PERIOD. */
function normalizeIsoDate(value, fieldName = 'date') {
  let iso = null;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) iso = value.toISOString().slice(0, 10);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (isRealCalendarDate(trimmed)) iso = trimmed;
  }
  if (!iso) throw invalidPeriod(`${fieldName} must be a real ISO date (YYYY-MM-DD)`);
  return iso;
}

/** Gregorian year the fiscal year with Buddhist-Era number `beYear` starts in. */
function gregorianStartYearOf(beYear) {
  const be = Number(beYear);
  if (!Number.isInteger(be)) {
    throw invalidPeriod('fiscalYear must be an integer Buddhist-Era year (e.g. 2569)');
  }
  return be - BE_FISCAL_START_OFFSET;
}

function assertFiscalYear(beYear) {
  const be = Number(beYear);
  const startYear = gregorianStartYearOf(be);
  if (startYear < MIN_GREGORIAN_YEAR || startYear > MAX_GREGORIAN_YEAR) {
    throw invalidPeriod('fiscalYear is outside the supported range (Gregorian 2000..2100)');
  }
  return { beYear: be, startYear };
}

/**
 * The twelve fiscal months of `beYear`, in calendar order: October..December of the start year, then
 * January..September of the next year. Same shape as the academic-year month list, so callers can loop
 * either period identically.
 */
function fiscalYearPeriod(beYear) {
  const { beYear: be, startYear } = assertFiscalYear(beYear);
  const endYear = startYear + 1;
  const months = [];
  for (let month = FISCAL_YEAR_START_MONTH; month <= 12; month += 1) months.push({ year: startYear, month });
  for (let month = 1; month < FISCAL_YEAR_START_MONTH; month += 1) months.push({ year: endYear, month });
  const gregorianFrom = `${startYear}-10-01`;
  const gregorianTo = `${endYear}-09-30`;
  return {
    fiscalYear: be,
    fiscalYearStartMonth: FISCAL_YEAR_START_MONTH,
    from: gregorianFrom,
    to: gregorianTo,
    gregorianFrom,
    gregorianTo,
    gregorianStartYear: startYear,
    labelTh: fiscalYearLabelTh(be),
    months,
  };
}

/**
 * The Buddhist-Era fiscal year an ISO date belongs to. 1 Oct starts the NEXT fiscal year; 30 Sep is the
 * LAST day of the current one. Pure string/BE arithmetic, no clock.
 */
function fiscalYearOf(isoDate) {
  const iso = normalizeIsoDate(isoDate, 'date');
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month >= FISCAL_YEAR_START_MONTH
    ? year + BE_FISCAL_START_OFFSET
    : year + BE_FISCAL_START_OFFSET - 1;
}

/** Thai label, e.g. 'ปีงบประมาณ 2569'. */
function fiscalYearLabelTh(beYear) {
  const be = Number(beYear);
  if (!Number.isInteger(be)) {
    throw invalidPeriod('fiscalYear must be an integer Buddhist-Era year (e.g. 2569)');
  }
  return `ปีงบประมาณ ${be}`;
}

module.exports = {
  FISCAL_YEAR_START_MONTH,
  BE_FISCAL_START_OFFSET,
  fiscalYearPeriod,
  fiscalYearOf,
  fiscalYearLabelTh,
  gregorianStartYearOf,
  normalizeIsoDate,
};
