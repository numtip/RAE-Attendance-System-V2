/**
 * Individual attendance reports (R-02): day, month and academic year for ONE employee.
 *
 * This service only READS. It never computes a day, never derives a month and never writes anything — the
 * numbers it reports are exactly the stored `daily_attendance` / `monthly_summary` rows, plus the
 * provenance that makes them checkable. That is deliberate: a report that recomputed would be a second
 * source of truth for the same period.
 *
 * What it adds on top of the raw rows is the honesty contract in `domain/attendanceReport.js`:
 *
 *   * `computationStatus` is ALWAYS present, and `isFinal` says whether that status is a conclusion. A
 *     `partial` or `pending_policy` month is reported as such and never as a set of final figures.
 *   * `ruleVersions` (which rule produced the numbers), `dateCutoff` (the newest day included) and
 *     `population` (exactly whose records these are) travel with every report.
 *   * `statusReasons` names WHY a report is not final, and `caveats` carries the limitations that must not
 *     be silently dropped: the empty holiday calendar, withheld overnight lateness, and the session-label
 *     approver.
 *
 * Scope is enforced through the same resolver every other read uses, on all three endpoints, BEFORE the
 * employee-existence check — so a caller outside the scope gets 403 rather than an existence oracle.
 */
const { HttpError } = require('../utils/httpError');
const { normalizeValidityDate } = require('../domain/identifierValidity');
const { assertCanReadEmployee } = require('./access');
const { formatBangkokWall, wallDateOnly } = require('../utils/bangkokTime');
const {
  REPORT_KIND,
  REPORT_CAVEAT,
  NOT_DERIVED,
  isSessionLabelApprover,
  describeCaveat,
  isFinalStatus,
  verdictOf,
  assertReportMonth,
  monthBoundsOf,
  academicYearPeriod,
  periodKeyOf,
} = require('../domain/attendanceReport');

const MONTH_TOTAL_FIELDS = Object.freeze([
  'totalWorkDays',
  'totalPresent',
  'totalLate',
  'totalAbsent',
  'totalLeave',
  'totalLateMinutes',
  'totalEarlyMinutes',
  'totalWorkHours',
]);

/** Sorted, de-duplicated union of rule-version codes from the stored month and the stored days. */
function unionOf(...lists) {
  const set = new Set();
  for (const list of lists) {
    for (const value of list || []) {
      if (value != null && value !== '') set.add(String(value));
    }
  }
  return Array.from(set).sort();
}

/** Newest stored day in a row set, or null. Both repository twins hand back 'YYYY-MM-DD' for `date`. */
function latestDay(rows) {
  let newest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = wallDateOnly(row?.date);
    if (day && (newest == null || day > newest)) newest = day;
  }
  return newest;
}

function countBy(rows, field) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.[field] == null ? 'unknown' : String(row[field]);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** The day as a report reader should see it: the conclusion, the span and the provenance, no internals. */
function presentDay(row) {
  if (!row) return null;
  return {
    date: wallDateOnly(row.date),
    status: row.status ?? null,
    computationStatus: row.computationStatus ?? null,
    isFinal: isFinalStatus(REPORT_KIND.DAY, row.computationStatus),
    dayClassification: row.dayClassification ?? null,
    checkIn: row.checkIn ?? null,
    checkOut: row.checkOut ?? null,
    isLate: row.isLate === true,
    lateMinutes: Number(row.lateMinutes) || 0,
    earlyMinutes: Number(row.earlyMinutes) || 0,
    workDuration: Number(row.workDuration) || 0,
    isLeave: row.isLeave === true,
    leaveType: row.leaveType ?? null,
    isOvernight: row.isOvernight === true,
    ruleVersionCode: row.ruleVersionCode ?? null,
    scheduleCode: row.scheduleCode ?? null,
    sourceEventCount: Number(row.sourceEventCount) || 0,
    sourceEventIds: Array.isArray(row.sourceEventIds) ? row.sourceEventIds : [],
    notes: row.notes ?? null,
    calculatedAt: row.calculatedAt ?? null,
    reconciliation: row.reconciliationJson ?? null,
  };
}

/** The rule behind the numbers, trimmed to what a reader needs and to nothing that is a secret. */
function ruleSummary(rule) {
  if (!rule) return null;
  return {
    ruleVersionCode: rule.ruleVersionCode ?? null,
    status: rule.status ?? null,
    effectiveFrom: rule.effectiveFrom ?? null,
    effectiveTo: rule.effectiveTo ?? null,
    approvedBy: rule.approvedBy ?? null,
    approvedAt: rule.approvedAt ?? null,
    workStart: rule.workStart ?? null,
    workEnd: rule.workEnd ?? null,
    lateAfter: rule.lateAfter ?? null,
    earlyBefore: rule.earlyBefore ?? null,
    workDays: Array.isArray(rule.workDays) ? rule.workDays : null,
    overnightShift: rule.overnightShift === true,
    ignoreHolidays: rule.ignoreHolidays !== false,
    notes: rule.notes ?? null,
  };
}

function monthTotals(stored) {
  return {
    totalWorkDays: stored.totalWorkDays,
    totalPresent: stored.totalPresent,
    totalLate: stored.totalLate,
    totalAbsent: stored.totalAbsent,
    totalLeave: stored.totalLeave,
    totalLateMinutes: stored.totalLateMinutes,
    totalEarlyMinutes: stored.totalEarlyMinutes,
    totalWorkHours: stored.totalWorkHours,
    expectedWorkingDays: stored.expectedWorkingDays ?? null,
    pendingDays: stored.pendingDays,
    holidayDays: stored.holidayDays,
  };
}

function dayStatusReasons(row) {
  if (!row) return ['day_never_calculated'];
  const status = String(row.computationStatus ?? '');
  if (isFinalStatus(REPORT_KIND.DAY, status)) return [];
  const reasons = [`day_${status || 'unknown'}`];
  const reason = row.reconciliationJson?.reason;
  if (reason) reasons.push(`day_reason:${reason}`);
  return reasons;
}

function monthStatusReasons(stored, unjudgedDays) {
  if (!stored) return ['month_never_derived'];
  const status = String(stored.computationStatus ?? '');
  if (isFinalStatus(REPORT_KIND.MONTH, status)) return [];
  if (status === 'partial' || status === 'pending_policy') {
    const reasons = [`month_${status}`];
    if (Number.isInteger(unjudgedDays)) reasons.push(`unjudged_days:${unjudgedDays}`);
    return reasons;
  }
  if (status === 'no_data') return ['month_no_daily_rows'];
  return [`month_${status || 'unknown'}`];
}

function createAttendanceReportService({ repositories, now = () => new Date() } = {}) {
  const daily = repositories.dailyAttendance;
  const summaries = repositories.monthlySummaries;
  const rules = repositories.attendanceRules;
  const employees = repositories.employees;

  /** Asia/Bangkok wall date for "today", so "has this month started?" is not decided in UTC. */
  const todayWallDate = () => formatBangkokWall(now()).slice(0, 10);

  /** Count of approved holidays in a window. An empty calendar is a CAVEAT, never an invisible assumption. */
  async function approvedHolidayCount({ from, to }) {
    if (typeof rules.listApprovedHolidays !== 'function') return 0;
    const holidays = await rules.listApprovedHolidays({ from, to });
    return Array.isArray(holidays) ? holidays.length : 0;
  }

  /**
   * Resolve rule provenance for a set of codes, memoised per call site so one report does not look the
   * same rule up twelve times.
   */
  function ruleLookup() {
    const cache = new Map();
    return async (codes) => {
      const found = [];
      for (const code of codes) {
        if (!cache.has(code)) cache.set(code, await rules.findRuleVersionByCode(code));
        const rule = cache.get(code);
        if (rule) found.push(rule);
      }
      return found;
    };
  }

  function collectCaveats({ overnight = false, approvers = [], holidayCalendarEmpty = false } = {}) {
    const codes = [];
    if (holidayCalendarEmpty) codes.push(REPORT_CAVEAT.HOLIDAY_CALENDAR_EMPTY);
    if (overnight) codes.push(REPORT_CAVEAT.NIGHT_SHIFT_LATENESS_WITHHELD);
    if (approvers.some(isSessionLabelApprover)) codes.push(REPORT_CAVEAT.APPROVER_IS_SESSION_LABEL);
    return codes.map(describeCaveat);
  }

  function buildReportHeader({
    kind, period, employeeUid, computationStatus, isFinal, ruleVersions, dateCutoff, dayRows,
    statusReasons, caveats,
  }) {
    return {
      kind,
      period,
      population: { employees: 1, employeeUid, dayRows },
      ruleVersions,
      dateCutoff,
      computationStatus,
      isFinal,
      statusReasons,
      caveats,
      generatedFrom: 'stored_daily_attendance',
    };
  }

  /** Scope first, existence second: a caller outside the scope must not learn whether the id exists. */
  async function assertReadable(auth, employeeUid) {
    await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
    if (!employees || typeof employees.findByUid !== 'function') return;
    const employee = await employees.findByUid(employeeUid);
    if (!employee) throw new HttpError(404, 'REPORT_UNKNOWN_EMPLOYEE', 'Employee was not found');
  }

  return {
    /** One employee-day, as stored. */
    async dayReport(auth, employeeUid, date) {
      const isoDate = normalizeValidityDate(date, 'date');
      if (!isoDate) throw new HttpError(400, 'REPORT_INVALID_DATE', 'date is required');
      await assertReadable(auth, employeeUid);

      const row = await daily.findForEmployeeDate(employeeUid, isoDate);
      const ruleVersions = row?.ruleVersionCode ? [String(row.ruleVersionCode)] : [];
      const rulesFound = await ruleLookup()(ruleVersions);
      const computationStatus = row ? String(row.computationStatus ?? NOT_DERIVED) : NOT_DERIVED;

      return {
        report: buildReportHeader({
          kind: REPORT_KIND.DAY,
          period: { from: isoDate, to: isoDate, date: isoDate },
          employeeUid,
          computationStatus,
          isFinal: row != null && isFinalStatus(REPORT_KIND.DAY, computationStatus),
          ruleVersions,
          dateCutoff: row ? wallDateOnly(row.date) : null,
          dayRows: row ? 1 : 0,
          statusReasons: dayStatusReasons(row),
          caveats: collectCaveats({
            overnight: row?.isOvernight === true,
            approvers: rulesFound.map((rule) => rule.approvedBy),
          }),
        }),
        day: presentDay(row),
        rule: ruleSummary(rulesFound[0] ?? null),
      };
    },

    /** One employee-month, derived from the stored day rows. Never a fabricated month of zeros. */
    async monthReport(auth, employeeUid, year, month) {
      const period = assertReportMonth(year, month);
      await assertReadable(auth, employeeUid);

      const bounds = monthBoundsOf(period.year, period.month);
      const key = periodKeyOf(period.year, period.month);
      const [stored, rows, holidayCount] = await Promise.all([
        summaries.findForEmployeeMonth(employeeUid, period.year, period.month),
        daily.listForRange({ employeeUid, from: bounds.from, to: bounds.to }),
        approvedHolidayCount(bounds),
      ]);

      const ruleVersions = unionOf(stored?.ruleVersions, rows.map((row) => row.ruleVersionCode));
      const rulesFound = await ruleLookup()(ruleVersions);
      const computationStatus = stored ? String(stored.computationStatus ?? NOT_DERIVED) : NOT_DERIVED;
      const unjudgedDays = stored?.dayCounts?.unjudgedDays;

      return {
        report: buildReportHeader({
          kind: REPORT_KIND.MONTH,
          period: {
            from: bounds.from, to: bounds.to, year: period.year, month: period.month, key,
          },
          employeeUid,
          computationStatus,
          isFinal: isFinalStatus(REPORT_KIND.MONTH, computationStatus),
          ruleVersions,
          dateCutoff: latestDay(rows),
          dayRows: rows.length,
          statusReasons: monthStatusReasons(stored, unjudgedDays),
          caveats: collectCaveats({
            overnight: rows.some((row) => row.isOvernight === true),
            approvers: rulesFound.map((rule) => rule.approvedBy),
            holidayCalendarEmpty: holidayCount === 0 && stored?.expectedWorkingDays != null,
          }),
        }),
        month: stored
          ? {
            year: stored.year,
            month: stored.month,
            computationStatus: stored.computationStatus,
            isFinal: isFinalStatus(REPORT_KIND.MONTH, stored.computationStatus),
            ...monthTotals(stored),
            ruleVersions: Array.isArray(stored.ruleVersions) ? stored.ruleVersions : [],
            dayCounts: stored.dayCounts ?? {},
            derivationNotes: stored.derivationNotes ?? null,
            calculatedAt: stored.calculatedAt ?? null,
            sourceKind: stored.sourceKind ?? null,
          }
          : null,
        days: rows.map(presentDay),
        dayCounts: {
          rows: rows.length,
          byStatus: countBy(rows, 'status'),
          byComputationStatus: countBy(rows, 'computationStatus'),
        },
      };
    },

    /**
     * The twelve months of a Thai academic year (1 June - 31 May) for one employee.
     *
     * Months that have not started yet are reported as `notYetStarted` and are excluded from the
     * completeness verdict: a month that has not happened cannot be "missing data". Every month that HAS
     * started is listed with its own status, and the year is final only when the period is closed and every
     * started month is derived and `calculated`.
     */
    async academicYearReport(auth, employeeUid, startYear) {
      const period = academicYearPeriod(startYear);
      await assertReadable(auth, employeeUid);

      const today = todayWallDate();
      const lookup = ruleLookup();

      const months = await Promise.all(period.months.map(async (entry) => {
        const bounds = monthBoundsOf(entry.year, entry.month);
        const key = periodKeyOf(entry.year, entry.month);
        const [stored, rows, holidayCount] = await Promise.all([
          summaries.findForEmployeeMonth(employeeUid, entry.year, entry.month),
          daily.listForRange({ employeeUid, from: bounds.from, to: bounds.to }),
          approvedHolidayCount(bounds),
        ]);
        const ruleVersions = unionOf(stored?.ruleVersions, rows.map((row) => row.ruleVersionCode));
        const rulesFound = await lookup(ruleVersions);
        const computationStatus = stored ? String(stored.computationStatus ?? NOT_DERIVED) : NOT_DERIVED;
        const started = today >= bounds.from;
        return {
          key,
          year: entry.year,
          month: entry.month,
          from: bounds.from,
          to: bounds.to,
          started,
          reportAvailable: stored != null,
          computationStatus,
          isFinal: started && isFinalStatus(REPORT_KIND.MONTH, computationStatus),
          dateCutoff: latestDay(rows),
          dayRows: rows.length,
          ruleVersions,
          totals: stored ? monthTotals(stored) : null,
          statusReasons: started
            ? monthStatusReasons(stored, stored?.dayCounts?.unjudgedDays)
            : ['month_not_yet_started'],
          caveats: collectCaveats({
            overnight: rows.some((row) => row.isOvernight === true),
            approvers: rulesFound.map((rule) => rule.approvedBy),
            holidayCalendarEmpty: holidayCount === 0 && stored?.expectedWorkingDays != null,
          }),
        };
      }));

      const considered = months.filter((entry) => entry.started);
      const notYetStarted = months.filter((entry) => !entry.started);
      const missing = considered.filter((entry) => !entry.reportAvailable);
      const rollupStatus = verdictOf(considered.map((entry) => entry.computationStatus)) ?? NOT_DERIVED;
      const periodClosed = today > period.to;

      const statusReasons = [];
      if (!periodClosed) statusReasons.push('academic_year_not_closed');
      for (const entry of missing) statusReasons.push(`month_not_derived:${entry.key}`);
      for (const entry of considered) {
        if (entry.isFinal || entry.computationStatus === NOT_DERIVED) continue;
        statusReasons.push(`month_${entry.computationStatus}:${entry.key}`);
      }

      const storedMonths = considered.filter((entry) => entry.totals != null);
      const totals = {};
      for (const field of MONTH_TOTAL_FIELDS) {
        totals[field] = storedMonths.reduce((sum, entry) => sum + (Number(entry.totals[field]) || 0), 0);
      }
      totals.pendingDays = storedMonths.reduce((sum, entry) => sum + (Number(entry.totals.pendingDays) || 0), 0);
      totals.holidayDays = storedMonths.reduce((sum, entry) => sum + (Number(entry.totals.holidayDays) || 0), 0);
      // A summed NULL would read as zero ("nobody was expected to work"), so it stays NULL unless every
      // stored month could derive it.
      const expectedValues = storedMonths.map((entry) => entry.totals.expectedWorkingDays);
      totals.expectedWorkingDays = storedMonths.length > 0 && expectedValues.every((value) => value != null)
        ? expectedValues.reduce((sum, value) => sum + Number(value), 0)
        : null;

      const caveatCodes = [];
      for (const entry of considered) {
        for (const caveat of entry.caveats) {
          if (!caveatCodes.includes(caveat.code)) caveatCodes.push(caveat.code);
        }
      }

      const isFinal = periodClosed && isFinalStatus(REPORT_KIND.ACADEMIC_YEAR, rollupStatus);

      return {
        report: buildReportHeader({
          kind: REPORT_KIND.ACADEMIC_YEAR,
          period: {
            from: period.from,
            to: period.to,
            academicYear: period.academicYear,
            academicYearStartMonth: period.academicYearStartMonth,
          },
          employeeUid,
          computationStatus: rollupStatus,
          isFinal,
          ruleVersions: unionOf(...months.map((entry) => entry.ruleVersions)),
          dateCutoff: months.map((entry) => entry.dateCutoff).filter(Boolean).sort().pop() ?? null,
          dayRows: months.reduce((sum, entry) => sum + entry.dayRows, 0),
          statusReasons,
          caveats: caveatCodes.map(describeCaveat),
        }),
        months,
        yearSummary: {
          academicYear: period.academicYear,
          from: period.from,
          to: period.to,
          periodClosed,
          asOf: today,
          monthsInPeriod: months.length,
          monthsStarted: considered.length,
          monthsNotYetStarted: notYetStarted.map((entry) => entry.key),
          monthsMissing: missing.map((entry) => entry.key),
          monthStatusCounts: countBy(considered, 'computationStatus'),
          totals,
        },
      };
    },
  };
}

module.exports = {
  createAttendanceReportService,
  presentDay,
  monthTotals,
  unionOf,
  latestDay,
};
