/**
 * R-05 annual HR report domain. PURE: no I/O, no database, no clock.
 *
 * The annual layer AGGREGATES the twelve monthly reports that `attendanceReportService` (R-02) already
 * publishes. It never recomputes a day, never re-derives a month and never re-judges a status: every
 * number it rolls up was produced by the monthly layer, and this module only decides what may be summed.
 *
 * It exists for two rules the reference project states plainly in its own `site/index.html` (verified
 * 2026-10-16 in `G:\ProjectAI\attendance-report-generator`, read-only — nothing was copied from it):
 *
 *   1. "months where the employee code changed owner are NOT summed together" — a code whose holder
 *      changed must not merge two people into one annual total. This layer keys everything on
 *      `employeeUid`, so two holders of one code are two employees and their months can never be added
 *      together (see `crossEmployeeOwnershipDetection` in the service payload for what is and is not
 *      detectable from the repository contract).
 *   2. "fields with no source are NOT filled with 0" — an annual total whose source is incomplete stays
 *      EMPTY, never zeroed, and never a partial sum presented as the annual figure.
 *
 * NULL DISCIPLINE (the core of this module). A metric's annual total is available ONLY when every month
 * of the period contributed a usable value. If ANY month is not yet started, never derived, or not
 * judged, the total for that metric is `null` with a recorded reason, mirroring how R-02/E25 treats
 * `expectedWorkingDays`. A partial sum is never published as the annual total.
 *
 * TWO YEAR CONVENTIONS, never conflated:
 *   * Thai FISCAL year (ปีงบประมาณ) — 1 October..30 September, named by a Buddhist-Era year (2569).
 *     Reuses `fiscalYearPeriod` from `domain/reconciliationPeriod.js` (R-04).
 *   * Thai ACADEMIC year (ปีการศึกษา) — 1 June..31 May, named by the Gregorian year it starts.
 *     Reuses `academicYearPeriod` from `domain/attendanceReport.js` (R-02).
 * `annualPeriodOf()` is the only way in, it always stamps `periodKind` on the descriptor, and a test
 * asserts the two windows differ for the same request year.
 *
 * Nothing here invents a Thai label. `fiscalYearPeriod` already owns 'ปีงบประมาณ N'; the academic label
 * is composed with the same displayed Buddhist-Era convention (DISPLAY ONLY — the Gregorian window stays
 * in `from`/`to`).
 */
const { HttpError } = require('../utils/httpError');
const {
  REPORT_KIND,
  NOT_DERIVED,
  verdictOf,
  isFinalStatus,
  academicYearPeriod,
} = require('./attendanceReport');
const { fiscalYearPeriod } = require('./reconciliationPeriod');

/** The two supported annual conventions. Always stamped on `report.period.periodKind`. */
const ANNUAL_PERIOD_KIND = Object.freeze({
  FISCAL: 'fiscal',
  ACADEMIC: 'academic',
});

/** Sorted list, so a caller or a test can enumerate the supported kinds without hardcoding them. */
const ANNUAL_PERIOD_KINDS = Object.freeze([ANNUAL_PERIOD_KIND.FISCAL, ANNUAL_PERIOD_KIND.ACADEMIC]);

/**
 * The annual verdict. Deliberately a two-value conclusion, following the discipline of R-04's `verdictOf`:
 * the WORST month decides, and a year with nothing to judge is `incomplete`, never `complete`/`matched`.
 */
const ANNUAL_VERDICT = Object.freeze({
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
});

/** Why a month did not contribute to the annual totals. Machine-stable codes. */
const MONTH_EXCLUSION = Object.freeze({
  NOT_YET_STARTED: 'month_not_yet_started',
  NEVER_DERIVED: 'month_not_derived',
  STATUS_PREFIX: 'month_',
});

/** Why a metric's annual total is `null`. Recorded per metric, never inferred by a reader. */
const ANNUAL_TOTAL_REASON = Object.freeze({
  /** At least one month of the period did not contribute, so no complete-year figure exists. */
  INCOMPLETE_COVERAGE: 'annual_total_requires_a_complete_year',
  /** Every month contributed, but a month's own value for this metric could not be derived. */
  VALUE_UNAVAILABLE: 'month_value_not_derivable_in_every_month',
});

/** The metrics summed from the monthly rows. `expectedWorkingDays` is nullable and handled separately. */
const ANNUAL_TOTAL_FIELDS = Object.freeze([
  'totalWorkDays',
  'totalPresent',
  'totalLate',
  'totalAbsent',
  'totalLeave',
  'totalLateMinutes',
  'totalEarlyMinutes',
  'totalWorkHours',
  'pendingDays',
  'holidayDays',
]);

/** The nullable extra metric: NULL unless every contributing month could derive it (mirrors E25). */
const ANNUAL_NULLABLE_FIELD = 'expectedWorkingDays';

/** The reported calendar kind for each convention, used as `report.kind`. */
const ANNUAL_REPORT_KIND = Object.freeze({
  [ANNUAL_PERIOD_KIND.FISCAL]: 'annual_fiscal',
  [ANNUAL_PERIOD_KIND.ACADEMIC]: 'annual_academic',
});

/** Gregorian year -> Buddhist-Era year for a DISPLAY label only. `fiscalYearPeriod` does the same. */
function buddhistYear(gregorianYear) {
  const year = Number(gregorianYear);
  return Number.isFinite(year) ? year + 543 : null;
}

/**
 * The twelve fiscal months of Buddhist-Era `beYear` (1 Oct..30 Sep), described explicitly.
 * Throws `RECONCILIATION_INVALID_PERIOD` (400) through `fiscalYearPeriod` for a bad year — REUSED, not
 * re-validated here.
 */
function fiscalAnnualPeriod(beYear) {
  const period = fiscalYearPeriod(beYear);
  return {
    periodKind: ANNUAL_PERIOD_KIND.FISCAL,
    reportKind: ANNUAL_REPORT_KIND[ANNUAL_PERIOD_KIND.FISCAL],
    fiscalYear: period.fiscalYear,
    startMonth: period.fiscalYearStartMonth,
    labelTh: period.labelTh,
    from: period.from,
    to: period.to,
    gregorianFrom: period.gregorianFrom,
    gregorianTo: period.gregorianTo,
    months: period.months.map((entry) => ({ ...entry })),
  };
}

/**
 * The twelve academic months of the year that STARTS in Gregorian `startYear` (1 Jun..31 May).
 * Throws `REPORT_INVALID_PERIOD` (400) through `academicYearPeriod` for a bad year.
 */
function academicAnnualPeriod(startYear) {
  const period = academicYearPeriod(startYear);
  return {
    periodKind: ANNUAL_PERIOD_KIND.ACADEMIC,
    reportKind: ANNUAL_REPORT_KIND[ANNUAL_PERIOD_KIND.ACADEMIC],
    academicYear: period.academicYear,
    startMonth: period.academicYearStartMonth,
    labelTh: `ปีการศึกษา ${buddhistYear(period.academicYear)}`,
    from: period.from,
    to: period.to,
    gregorianFrom: period.from,
    gregorianTo: period.to,
    months: period.months.map((entry) => ({ ...entry })),
  };
}

/**
 * The one entry point. A caller must NAME the convention it wants; there is no default, because silently
 * choosing a window is exactly the ambiguity this module exists to prevent.
 */
function annualPeriodOf(periodKind, year) {
  if (periodKind === ANNUAL_PERIOD_KIND.FISCAL) return fiscalAnnualPeriod(year);
  if (periodKind === ANNUAL_PERIOD_KIND.ACADEMIC) return academicAnnualPeriod(year);
  throw new HttpError(
    400,
    'ANNUAL_INVALID_PERIOD_KIND',
    `period kind must be one of: ${ANNUAL_PERIOD_KINDS.join(', ')}`,
  );
}

/**
 * Why a month did not contribute to the annual totals, or `null` when it did.
 * A month that has not STARTED is a gap in the period, not "missing data", so it is reported separately
 * from a month that started and was never derived — the same distinction R-02 draws for a year rollup.
 */
function monthExclusionReason(entry) {
  if (entry == null) return MONTH_EXCLUSION.NEVER_DERIVED;
  if (entry.started === false) return MONTH_EXCLUSION.NOT_YET_STARTED;
  if (entry.reportAvailable !== true) return MONTH_EXCLUSION.NEVER_DERIVED;
  if (entry.isFinal !== true) {
    return `${MONTH_EXCLUSION.STATUS_PREFIX}${entry.computationStatus || 'unknown'}`;
  }
  return null;
}

/**
 * Which months contributed and which did not, with the reason for each exclusion.
 * `complete` is true only when EVERY month of the period contributed — an empty period is never complete.
 */
function buildMonthCoverage(monthEntries) {
  const list = Array.isArray(monthEntries) ? monthEntries : [];
  const monthsContributed = [];
  const monthsExcluded = [];
  for (const entry of list) {
    const reason = monthExclusionReason(entry);
    if (reason == null) monthsContributed.push(entry.key);
    else monthsExcluded.push({ key: entry.key, reason });
  }
  const reasonCodes = [];
  for (const item of monthsExcluded) {
    if (!reasonCodes.includes(item.reason)) reasonCodes.push(item.reason);
  }
  return {
    monthsInPeriod: list.length,
    monthsContributed,
    monthsExcluded,
    complete: list.length > 0 && monthsExcluded.length === 0,
    reasonCodes,
  };
}

/** A metric value is usable only when it is present and finite — `null` is NOT `0`. */
function isUsableValue(value) {
  return value != null && Number.isFinite(Number(value));
}

/**
 * The annual totals plus, per metric, whether it exists and why not.
 *
 * `totals[field]` is a number ONLY when every month of the period contributed AND every contributing
 * month has a usable value for that field. Otherwise it is `null` and `availability[field].reason` says
 * why. A partial sum is never returned: `null` is the honest answer, and `0` would read as
 * "nothing happened".
 */
function buildAnnualTotals(monthEntries, coverage = buildMonthCoverage(monthEntries)) {
  const contributed = (Array.isArray(monthEntries) ? monthEntries : [])
    .filter((entry) => monthExclusionReason(entry) == null);

  const totals = {};
  const availability = {};

  for (const field of ANNUAL_TOTAL_FIELDS) {
    const usable = coverage.complete && contributed.every((entry) => isUsableValue(entry.totals?.[field]));
    totals[field] = usable
      ? contributed.reduce((sum, entry) => sum + Number(entry.totals[field]), 0)
      : null;
    availability[field] = {
      available: usable,
      reason: usable
        ? null
        : (coverage.complete ? ANNUAL_TOTAL_REASON.VALUE_UNAVAILABLE : ANNUAL_TOTAL_REASON.INCOMPLETE_COVERAGE),
    };
  }

  // A summed NULL would read as "nobody was expected to work", so it stays NULL unless every
  // contributing month could derive it. Same rule as R-02's year rollup (E25).
  const expectedUsable = coverage.complete && contributed.length > 0
    && contributed.every((entry) => isUsableValue(entry.totals?.[ANNUAL_NULLABLE_FIELD]));
  totals[ANNUAL_NULLABLE_FIELD] = expectedUsable
    ? contributed.reduce((sum, entry) => sum + Number(entry.totals[ANNUAL_NULLABLE_FIELD]), 0)
    : null;
  availability[ANNUAL_NULLABLE_FIELD] = {
    available: expectedUsable,
    reason: expectedUsable
      ? null
      : (coverage.complete ? ANNUAL_TOTAL_REASON.VALUE_UNAVAILABLE : ANNUAL_TOTAL_REASON.INCOMPLETE_COVERAGE),
  };

  return { totals, availability };
}

/**
 * The annual verdict, following R-04's `verdictOf` discipline: worst-of across months, and a period with
 * nothing to judge is `incomplete` — never `complete`, never "matched".
 *
 *   * no month has STARTED            -> `incomplete` (nothing to compare)
 *   * the period is not closed        -> `incomplete` (a year still in progress cannot be concluded)
 *   * every started month is final    -> `complete`
 *   * any started month is not final  -> `incomplete`
 */
function annualVerdictOf({ months = [], periodClosed = false } = {}) {
  const considered = (Array.isArray(months) ? months : []).filter((entry) => entry.started === true);
  if (considered.length === 0) return ANNUAL_VERDICT.INCOMPLETE;
  if (!periodClosed) return ANNUAL_VERDICT.INCOMPLETE;
  return considered.every((entry) => entry.isFinal === true)
    ? ANNUAL_VERDICT.COMPLETE
    : ANNUAL_VERDICT.INCOMPLETE;
}

/** The worst month status (R-02's severity order), or `not_derived` when nothing is recognisable. */
function annualComputationStatusOf(months = []) {
  const statuses = (Array.isArray(months) ? months : []).map((entry) => entry?.computationStatus);
  return verdictOf(statuses) ?? NOT_DERIVED;
}

/** True when a month status is a conclusion for a MONTH (reused from R-02, never re-declared here). */
function isFinalMonthStatus(status) {
  return isFinalStatus(REPORT_KIND.MONTH, status);
}

module.exports = {
  ANNUAL_PERIOD_KIND,
  ANNUAL_PERIOD_KINDS,
  ANNUAL_VERDICT,
  ANNUAL_REPORT_KIND,
  ANNUAL_TOTAL_FIELDS,
  ANNUAL_NULLABLE_FIELD,
  ANNUAL_TOTAL_REASON,
  MONTH_EXCLUSION,
  fiscalAnnualPeriod,
  academicAnnualPeriod,
  annualPeriodOf,
  monthExclusionReason,
  buildMonthCoverage,
  buildAnnualTotals,
  annualVerdictOf,
  annualComputationStatusOf,
  isFinalMonthStatus,
};
