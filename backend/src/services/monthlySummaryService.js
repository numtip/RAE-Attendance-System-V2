/**
 * Slice 3: the monthly summary service.
 *
 * It DERIVES monthly_summary from the stored daily_attendance rows. It never recomputes a day and never
 * reads scans, so a month total can always be traced to the days that produced it.
 *
 * Design rules this file enforces:
 *
 *  1. Deterministic. The clock is passed in (`calculatedAt`), never read inside the derivation, so the same
 *     stored days reproduce the same month.
 *
 *  2. Idempotent. `upsertMonth` is keyed on (employee_uid, year, month) — one row per employee-month.
 *
 *  3. Never presents a partial month as final. If any day could not be judged, or no approved rule covers
 *     the month, the stored `computation_status` says so and `expected_working_days` stays NULL rather than
 *     publishing a misleading zero.
 *
 *  4. Scope is enforced, including on the organization-wide path. This is the exact place where Slice 2
 *     shipped an authorization hole (an unscoped recalculation rebuilt and returned every employee), so the
 *     org-wide branch below requires a resolved BROAD scope and is covered by its own test.
 */
const { HttpError } = require('../utils/httpError');
const {
  calculateMonthlySummary,
  enumerateMonthDays,
  assertPeriod,
  dayKeyOf,
} = require('../domain/monthlyAttendanceCalculation');
const { assertCanReadEmployee } = require('./access');
const { canonicalRole, ROLES, resolveScope } = require('./authorizationService');

function assertCanRecalculate(auth) {
  const role = canonicalRole(auth && auth.role);
  if (role === ROLES.ADMIN || role === ROLES.MANAGER) return role;
  throw new HttpError(403, 'FORBIDDEN', 'Attendance calculation requires a manager or admin role');
}

function monthBounds(year, month) {
  const days = enumerateMonthDays(year, month);
  return { from: days[0], to: days[days.length - 1], days };
}

/**
 * The fields that represent a month's RESULT. Used to decide whether a stored month is stale.
 *
 * Comparing timestamps alone is not reliable: a derivation and a daily recalculation can land in the same
 * millisecond, and `calculatedAt` moves on every run regardless of whether anything changed. Comparing the
 * derived values answers the question a reader actually has — "does the stored month still match the data?"
 */
const MONTH_RESULT_FIELDS = Object.freeze([
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
  'expectedWorkingDays',
  'computationStatus',
]);

function differingResultFields(stored, derived) {
  const differing = [];
  for (const field of MONTH_RESULT_FIELDS) {
    if (stored?.[field] !== derived?.[field]) differing.push(field);
  }
  if ((stored?.ruleVersions ?? []).join(',') !== (derived?.ruleVersions ?? []).join(',')) {
    differing.push('ruleVersions');
  }
  return differing;
}

/**
 * Normalize a stored timestamp to epoch milliseconds so two timestamps can be compared MEANINGFULLY.
 *
 * Comparing the raw strings is a trap this slice hit: a naive wall value ('2031-11-03 23:00:00', which is
 * what a DATETIME column can yield) and an ISO value ('2026-10-16T04:16:45.000Z', which is what the daily
 * repository returns) compare LEXICOGRAPHICALLY, so '2031-...' looks newer than '2026-...' purely because
 * of the year digits and the separator character. A naive value is read as UTC here so that a naive and an
 * ISO timestamp describing the same instant compare equal. Returns null when unparseable, so the caller can
 * decide instead of guessing.
 */
function toEpochMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const text = String(value).trim();
  if (!text) return null;
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoish);
  const stamp = Date.parse(hasZone ? isoish : `${isoish}Z`);
  return Number.isNaN(stamp) ? null : stamp;
}

/** Newest `calculatedAt` among the day rows, compared by instant (not lexicographically), or null. */
function newestDailyCalculatedAt(rows) {
  let newestMs = null;
  let newestText = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const stamp = row?.calculatedAt;
    if (stamp == null) continue;
    const text = stamp instanceof Date ? stamp.toISOString() : String(stamp);
    const ms = toEpochMillis(text);
    if (ms == null) continue;
    if (newestMs == null || ms > newestMs) {
      newestMs = ms;
      newestText = text;
    }
  }
  return newestText;
}

function createMonthlySummaryService({ repositories, now = () => new Date() } = {}) {
  const daily = repositories.dailyAttendance;
  const summaries = repositories.monthlySummaries;
  const rules = repositories.attendanceRules;
  const employees = repositories.employees;

  /**
   * Resolve the approved rule and holiday for every day of the month. The domain stays pure and receives
   * this as plain data. One lookup pair per calendar day: fine for a derivation job, and it keeps the
   * "which rule covers this exact date" question in the rule repository where it belongs.
   */
  async function buildCalendar(employeeUid, year, month) {
    const days = enumerateMonthDays(year, month);
    const calendar = [];
    for (const date of days) {
      const [rule, holiday] = await Promise.all([
        rules.findEffectiveRuleVersion(date),
        rules.findHolidayOn(date),
      ]);
      calendar.push({
        date,
        rule: rule
          ? { workDays: rule.workDays ?? null, ignoreHolidays: rule.ignoreHolidays !== false }
          : null,
        holiday: Boolean(holiday),
      });
    }
    return calendar;
  }

  /** Derive a month WITHOUT writing. Returns the summary body plus a diagnosis. */
  async function deriveMonth({ employeeUid, year, month, calculatedAt = null }) {
    assertPeriod(year, month);
    if (!employeeUid) {
      throw new HttpError(400, 'MONTHLY_INVALID_EMPLOYEE', 'employeeUid is required');
    }
    const { from, to } = monthBounds(year, month);
    const [dailyRows, calendar] = await Promise.all([
      daily.listForRange({ employeeUid, from, to }),
      buildCalendar(employeeUid, year, month),
    ]);

    const summary = calculateMonthlySummary({
      employeeUid,
      year,
      month,
      dailyRows,
      calendar,
      calculatedAt: calculatedAt || now().toISOString(),
    });

    const rulesWithoutWeek = calendar.filter((entry) => entry.rule && entry.rule.workDays == null).length;
    return {
      summary,
      diagnosis: {
        employeeUid,
        year,
        month,
        dailyRows: dailyRows.length,
        computationStatus: summary.computationStatus,
        unjudgedDays: summary.dayCounts.unjudgedDays,
        expectedWorkingDays: summary.expectedWorkingDays,
        missingWorkingDays: summary.dayCounts.missingWorkingDays ?? null,
        ruleVersions: summary.ruleVersions,
        ...(rulesWithoutWeek > 0 ? { daysWithoutWorkingWeek: rulesWithoutWeek } : {}),
      },
    };
  }

  async function deriveAndStore(args) {
    const { summary, diagnosis } = await deriveMonth(args);
    const stored = await summaries.upsertMonth(summary);
    return { stored, diagnosis };
  }

  return {
    /** Derive and store one employee-month. Idempotent. Manager/admin only: this WRITES derived data. */
    async recalculateMonth(auth, employeeUid, year, month) {
      assertCanRecalculate(auth);
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const employee = await employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return deriveAndStore({
        employeeUid, year: Number(year), month: Number(month), calculatedAt: now().toISOString(),
      });
    },

    /**
     * Derive and store every month of a year for one employee, or for every employee that has daily rows in
     * that year. The organization-wide form requires a resolved broad scope — role alone is not enough.
     */
    async recalculate(auth, {
      employeeUid = null, year, month = null,
    } = {}) {
      const role = assertCanRecalculate(auth);
      const parsedYear = Number(year);
      if (!Number.isInteger(parsedYear)) {
        throw new HttpError(400, 'MONTHLY_INVALID_PERIOD', 'year is required');
      }
      const months = month == null
        ? Array.from({ length: 12 }, (_, index) => index + 1)
        : [Number(month)];
      for (const candidate of months) assertPeriod(parsedYear, candidate);

      let targetUids;
      if (employeeUid) {
        await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
        const employee = await employees.findByUid(employeeUid);
        if (!employee) {
          throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
        }
        targetUids = [employeeUid];
      } else {
        const scope = await resolveScope(auth, repositories, 'data');
        if (!scope.all && !scope.broad) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'Organization-wide recalculation requires a broad data scope (an authorization grant)',
          );
        }
        const from = `${parsedYear}-01-01`;
        const to = `${parsedYear}-12-31`;
        const withRows = await daily.listEmployeeUidsWithDailyRows({ from, to });
        targetUids = scope.all ? withRows : withRows.filter((uid) => scope.uids.has(uid));
      }

      const calculatedAt = now().toISOString();
      const results = [];
      const summary = {
        year: parsedYear,
        employees: targetUids.length,
        months: months.length,
        calculated: 0,
        partial: 0,
        pendingPolicy: 0,
        noData: 0,
        failed: 0,
        monthsWritten: 0,
      };

      for (const uid of targetUids) {
        for (const candidate of months) {
          try {
            const { summary: derived, diagnosis } = await deriveMonth({
              employeeUid: uid, year: parsedYear, month: candidate, calculatedAt,
            });

            // A month with no daily rows and no existing row is NOT written: an empty row would read as a
            // real month of zeros. An existing row is refreshed so it stops claiming stale figures.
            let stored = null;
            const existing = await summaries.findForEmployeeMonth(uid, parsedYear, candidate);
            if (diagnosis.dailyRows > 0 || existing) {
              stored = await summaries.upsertMonth(derived);
              summary.monthsWritten += 1;
            }

            results.push({
              employeeUid: uid,
              month: candidate,
              computationStatus: derived.computationStatus,
              written: stored != null,
            });

            if (derived.computationStatus === 'calculated') summary.calculated += 1;
            else if (derived.computationStatus === 'partial') summary.partial += 1;
            else if (derived.computationStatus === 'pending_policy') summary.pendingPolicy += 1;
            else if (derived.computationStatus === 'no_data') summary.noData += 1;
            else summary.failed += 1;
          } catch (error) {
            // One bad month must not abort the run.
            summary.failed += 1;
            results.push({
              employeeUid: uid,
              month: candidate,
              computationStatus: 'failed',
              error: { code: error.code || 'MONTHLY_DERIVE_FAILED', message: error.message },
            });
          }
        }
      }

      return { summary, results, role, actor: auth?.employeeUid ?? null, calculatedAt };
    },

    /** Stored month, scope-enforced. Returns null when the month was never derived. */
    async getStored(auth, employeeUid, year, month) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      assertPeriod(Number(year), Number(month));
      return summaries.findForEmployeeMonth(employeeUid, Number(year), Number(month));
    },

    /** Stored months of a year, scope-enforced. */
    async listStored(auth, employeeUid, year) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const parsedYear = Number(year);
      if (!Number.isInteger(parsedYear)) {
        throw new HttpError(400, 'MONTHLY_INVALID_PERIOD', 'year is required');
      }
      return summaries.listForEmployeeYear(employeeUid, parsedYear);
    },

    /**
     * Show the stored month next to a fresh derivation, and whether the stored one is STALE.
     * `stale` compares the month's own calculatedAt against the newest calculatedAt among the day rows it
     * is built from, plus the row count — comparing timestamps alone would be wrong in the other direction
     * (a fresh derivation stamps a new time regardless of whether anything changed).
     */
    async explain(auth, employeeUid, year, month) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const parsedYear = Number(year);
      const parsedMonth = Number(month);
      assertPeriod(parsedYear, parsedMonth);

      const { summary, diagnosis } = await deriveMonth({
        employeeUid, year: parsedYear, month: parsedMonth,
      });
      const stored = await summaries.findForEmployeeMonth(employeeUid, parsedYear, parsedMonth);

      const { from, to } = monthBounds(parsedYear, parsedMonth);
      const dailyRows = await daily.listForRange({ employeeUid, from, to });
      const newestDaily = newestDailyCalculatedAt(dailyRows);

      const staleness = [];
      if (!stored) {
        staleness.push('month_has_never_been_derived');
      } else {
        // The authoritative signal: do the stored figures still match what the data says now?
        const differing = differingResultFields(stored, summary);
        if (differing.length > 0) {
          staleness.push('derived_values_differ');
          staleness.push(...differing.map((field) => `field_changed:${field}`));
        }
        // Secondary signal: the inputs themselves moved. Compared by INSTANT, not as strings, because a
        // naive wall datetime and an ISO timestamp do not order lexicographically.
        const storedAtMs = toEpochMillis(stored.calculatedAt);
        const newestDailyMs = toEpochMillis(newestDaily);
        if (storedAtMs == null || (newestDailyMs != null && newestDailyMs > storedAtMs)) {
          staleness.push('daily_rows_changed_after_derivation');
        }
        if ((stored.dayCounts?.rows ?? null) !== dailyRows.length) {
          staleness.push('daily_row_count_changed');
        }
      }

      return {
        employeeUid,
        year: parsedYear,
        month: parsedMonth,
        stored,
        derived: summary,
        diagnosis,
        stale: staleness.length > 0,
        staleReasons: staleness,
        newestDailyCalculatedAt: newestDaily,
      };
    },

    // exposed for tests
    deriveMonth,
    deriveAndStore,
  };
}

module.exports = {
  createMonthlySummaryService,
  assertCanRecalculate,
  monthBounds,
  newestDailyCalculatedAt,
  toEpochMillis,
  dayKeyOf,
};
