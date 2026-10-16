/**
 * Individual attendance reports (R-02). PURE: no I/O, no database, no clock.
 *
 * A report is a READ over data that was already computed and stored, and its whole job is to be honest
 * about what those numbers are worth. Every report described here therefore carries the three things the
 * milestone requires (docs/memory/NEXT_ACTIONS.md R-02):
 *
 *   1. the RULE VERSION(S) that produced the numbers,
 *   2. the DATE CUTOFF (the newest day actually included), and
 *   3. the POPULATION (exactly whose records the report covers),
 *
 * plus a `computationStatus` and an `isFinal` flag. The flag is the reason this module exists:
 *
 *   * a DAY is final once the engine reached a conclusion. `calculated` is a conclusion, and so is
 *     `no_data`: on a working day with an approved rule and no scan at all, "absent" is a finding, not a
 *     gap (DECISIONS.md E24). `insufficient_data` / `pending_policy` / `failed` are NOT conclusions.
 *   * a MONTH is final only when it is `calculated`, i.e. every day inside it was judged (DECISIONS.md
 *     E23). `partial`, `pending_policy` and even `no_data` are NOT final: a stored month of zeros whose
 *     days were never derived must never read as a month of attendance.
 *   * an ACADEMIC YEAR is final only when the period is closed and every month that has started is both
 *     derived and `calculated`.
 *
 * `not_derived` is this layer's own extra status: no stored row at all. It is never final, which is what
 * stops an absent row from rendering as a real month of zeros.
 *
 * Nothing here invents a number. `expected_working_days` stays NULL when it cannot be derived, and the
 * period boundaries (including the academic year) are REPORTING conventions that the response always
 * names explicitly rather than attendance-policy values.
 */
const { HttpError } = require('../utils/httpError');
const { enumerateMonthDays } = require('./monthlyAttendanceCalculation');

const REPORT_KIND = Object.freeze({
  DAY: 'day',
  MONTH: 'month',
  ACADEMIC_YEAR: 'academic_year',
});

/** No stored row exists for the requested scope, so there is nothing to report — and nothing is 0. */
const NOT_DERIVED = 'not_derived';

/** Union of the daily and monthly completeness vocabularies, plus `not_derived`. */
const REPORT_STATUS = Object.freeze([
  'calculated',
  'no_data',
  'insufficient_data',
  'partial',
  'pending_policy',
  'failed',
  NOT_DERIVED,
]);

/**
 * Higher = worse. Used to roll the twelve months of an academic year up into one verdict.
 * `insufficient_data` is the daily twin of a monthly `partial`, so they share a rank.
 */
const STATUS_SEVERITY = Object.freeze({
  calculated: 0,
  no_data: 1,
  [NOT_DERIVED]: 2,
  partial: 3,
  insufficient_data: 3,
  pending_policy: 4,
  failed: 5,
});

/**
 * Which statuses mean "this number may be read as a conclusion" for each scope.
 * The day list is deliberately wider than the month list: see E24 in the file header.
 */
const FINAL_STATUSES_BY_KIND = Object.freeze({
  [REPORT_KIND.DAY]: Object.freeze(['calculated', 'no_data']),
  [REPORT_KIND.MONTH]: Object.freeze(['calculated']),
  [REPORT_KIND.ACADEMIC_YEAR]: Object.freeze(['calculated']),
});

/**
 * A Thai academic year runs 1 June (Y) to 31 May (Y+1). This is a REPORTING period, not an approved
 * attendance-policy value, and every report states the window it used in `period`.
 */
const ACADEMIC_YEAR_START_MONTH = 6;

/**
 * Limitations that must travel WITH the numbers, because omitting them would let a reader treat an
 * incomplete figure as a complete one. Each is a code plus a plain-language detail.
 */
const REPORT_CAVEAT = Object.freeze({
  HOLIDAY_CALENDAR_EMPTY: 'HOLIDAY_CALENDAR_EMPTY',
  NIGHT_SHIFT_LATENESS_WITHHELD: 'NIGHT_SHIFT_LATENESS_WITHHELD',
  APPROVER_IS_SESSION_LABEL: 'APPROVER_IS_SESSION_LABEL',
});

const CAVEAT_DETAIL = Object.freeze({
  [REPORT_CAVEAT.HOLIDAY_CALENDAR_EMPTY]:
    'No approved holiday covers this period, so expected_working_days counts the working week only and '
    + 'will over-count on a holiday until an approved calendar is imported (PROJECT_STATE.md R8, S2-D).',
  [REPORT_CAVEAT.NIGHT_SHIFT_LATENESS_WITHHELD]:
    'At least one day is an overnight shift. Its span is recorded, but lateness and early departure are '
    + 'withheld until an approved overnight rule exists (P-03, DECISIONS.md E12).',
  [REPORT_CAVEAT.APPROVER_IS_SESSION_LABEL]:
    'A rule behind these numbers records approved_by as a SESSION LABEL, not a person, so no individual '
    + 'is accountable for the values yet (DECISIONS.md D-E, PROJECT_STATE.md R2).',
});

/**
 * The convention `approvedBy` uses today for an owner approval recorded by an agent session. When a real
 * accountable name is recorded in the rule, this stops matching and the caveat disappears on its own.
 */
const SESSION_LABEL_APPROVER = /^owner:session/;

function isSessionLabelApprover(approvedBy) {
  return typeof approvedBy === 'string' && SESSION_LABEL_APPROVER.test(approvedBy.trim());
}

function describeCaveat(code) {
  return { code, detail: CAVEAT_DETAIL[code] ?? null };
}

/** True when `status` is a conclusion for that scope (see FINAL_STATUSES_BY_KIND). */
function isFinalStatus(kind, status) {
  const allowed = FINAL_STATUSES_BY_KIND[kind] || [];
  return allowed.includes(String(status ?? ''));
}

/** The worst status in the list, or null when nothing recognisable was supplied. */
function verdictOf(statuses = []) {
  let worst = null;
  for (const candidate of Array.isArray(statuses) ? statuses : []) {
    const status = String(candidate ?? '');
    if (!Object.prototype.hasOwnProperty.call(STATUS_SEVERITY, status)) continue;
    if (worst == null || STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/** Throws REPORT_INVALID_PERIOD rather than letting a bad period reach a query. */
function assertReportMonth(year, month) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
    throw new HttpError(400, 'REPORT_INVALID_PERIOD', 'year must be an integer between 2000 and 2100');
  }
  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new HttpError(400, 'REPORT_INVALID_PERIOD', 'month must be an integer between 1 and 12');
  }
  return { year: parsedYear, month: parsedMonth };
}

/** Inclusive 'YYYY-MM-DD' bounds of a month. */
function monthBoundsOf(year, month) {
  const days = enumerateMonthDays(year, month);
  return { from: days[0], to: days[days.length - 1] };
}

/**
 * The twelve months of the academic year that STARTS in `startYear`, in calendar order: June..December of
 * `startYear`, then January..May of `startYear + 1`.
 */
function academicYearPeriod(startYear) {
  const start = Number(startYear);
  if (!Number.isInteger(start) || start < 2000 || start > 2100) {
    throw new HttpError(
      400,
      'REPORT_INVALID_PERIOD',
      'academic year must be an integer between 2000 and 2100 (the Gregorian year the academic year starts)',
    );
  }
  const months = [];
  for (let month = ACADEMIC_YEAR_START_MONTH; month <= 12; month += 1) months.push({ year: start, month });
  for (let month = 1; month < ACADEMIC_YEAR_START_MONTH; month += 1) months.push({ year: start + 1, month });
  return {
    academicYear: start,
    academicYearStartMonth: ACADEMIC_YEAR_START_MONTH,
    from: `${start}-06-01`,
    to: `${start + 1}-05-31`,
    months,
  };
}

/** `'YYYY-MM'` key of a month entry. */
function periodKeyOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

module.exports = {
  REPORT_KIND,
  REPORT_STATUS,
  NOT_DERIVED,
  STATUS_SEVERITY,
  FINAL_STATUSES_BY_KIND,
  ACADEMIC_YEAR_START_MONTH,
  REPORT_CAVEAT,
  CAVEAT_DETAIL,
  isSessionLabelApprover,
  describeCaveat,
  isFinalStatus,
  verdictOf,
  assertReportMonth,
  monthBoundsOf,
  academicYearPeriod,
  periodKeyOf,
};
