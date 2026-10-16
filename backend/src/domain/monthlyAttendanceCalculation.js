/**
 * Monthly attendance summary derivation (Slice 3). PURE: no I/O, no database, no clock.
 *
 * A month is DERIVED from the stored daily rows. It never recomputes a day and never re-reads scans — the
 * day rows are the single source of truth, so a month total can always be traced back to the days that
 * produced it.
 *
 * The completeness rule (the point of this module)
 *   A month total is only meaningful if every day in it could be judged. So the derivation always reports
 *   a `computation_status`:
 *     'no_data'        - no stored day rows at all for this employee-month
 *     'pending_policy' - at least one day is pending_policy: an approved rule is missing, so the month
 *                        cannot be judged no matter how many other days were fine
 *     'partial'        - no pending_policy, but at least one day is insufficient_data or failed
 *     'calculated'     - every stored day was judged
 *   A month is NEVER reported as 'calculated' while any day inside it is unjudged. `pending_days` counts
 *   the days behind a 'partial' or 'pending_policy' verdict so a reader can see the size of the hole.
 *
 * Note what does NOT make a month partial: a day with computation_status 'no_data' is a COMPLETE judgement
 * (the rule said it was a working day and no scan arrived, so the person was absent). That is a fact, not
 * a gap.
 */
const { HttpError } = require('../utils/httpError');

const MONTH_COMPUTATION_STATUS = Object.freeze([
  'calculated',
  'partial',
  'pending_policy',
  'no_data',
  'failed',
]);

/** Daily statuses the engine can produce (mirrors daily_attendance.status + migration 023). */
const DAILY_STATUS = Object.freeze(['present', 'late', 'absent', 'leave', 'holiday', 'pending']);

/** Day-level computation statuses that mean "this day could not be judged". */
const UNJUDGED_DAILY_STATUSES = Object.freeze(['pending_policy', 'insufficient_data', 'failed']);

const DEFAULT_WORK_DAYS = Object.freeze([1, 2, 3, 4, 5]);

// ---------------------------------------------------------------------------
// calendar helpers
// ---------------------------------------------------------------------------

function assertPeriod(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, 'MONTHLY_INVALID_PERIOD', 'year must be an integer between 2000 and 2100');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpError(400, 'MONTHLY_INVALID_PERIOD', 'month must be an integer between 1 and 12');
  }
}

/** Days in a month, correctly handling leap years (Feb 2028 = 29). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Every 'YYYY-MM-DD' in the month, ascending. */
function enumerateMonthDays(year, month) {
  assertPeriod(year, month);
  const total = daysInMonth(year, month);
  const days = [];
  for (let day = 1; day <= total; day += 1) {
    days.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return days;
}

/** ISO-8601 day number (1=Monday .. 7=Sunday) computed in UTC. */
function isoDayNumber(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  const weekday = probe.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** The month key of a 'YYYY-MM-DD' value, or null when unreadable. */
function monthKeyOf(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 7);
  }
  const text = String(value).trim();
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

/** The 'YYYY-MM-DD' day of a stored value, or null. Accepts a Date, as MariaDB returns for a DATE column. */
function dayKeyOf(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

// ---------------------------------------------------------------------------
// the derivation
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.employeeUid
 * @param {number} input.year
 * @param {number} input.month
 * @param {Array}  input.dailyRows  stored daily_attendance rows for this employee-month (any order)
 * @param {Array}  input.calendar   one entry per day of the month:
 *                                  `{ date, rule: { workDays, ignoreHolidays } | null, holiday: boolean }`
 *                                  `rule` null means no approved rule covers that day.
 * @param {string} [input.calculatedAt]
 * @returns {object} the monthly_summary row body
 */
function calculateMonthlySummary(input = {}) {
  const employeeUid = input.employeeUid ?? null;
  const { year, month } = input;
  assertPeriod(year, month);
  if (!employeeUid) {
    throw new HttpError(400, 'MONTHLY_INVALID_EMPLOYEE', 'employeeUid is required');
  }

  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const allDays = enumerateMonthDays(year, month);

  // Defensive: keep only rows that genuinely belong to this employee and this month. A caller that passes
  // the wrong slice must not silently inflate a total.
  const rows = (Array.isArray(input.dailyRows) ? input.dailyRows : []).filter((row) => {
    if (!row) return false;
    if (employeeUid != null && row.employeeUid != null && row.employeeUid !== employeeUid) return false;
    return monthKeyOf(row.date) === periodKey;
  });

  const calendar = Array.isArray(input.calendar) ? input.calendar : [];

  // --- counts from the stored day rows --------------------------------------
  const byStatus = Object.fromEntries(DAILY_STATUS.map((status) => [status, 0]));
  const byComputation = {
    calculated: 0, no_data: 0, insufficient_data: 0, pending_policy: 0, failed: 0,
  };
  let totalLateMinutes = 0;
  let totalEarlyMinutes = 0;
  let totalWorkHours = 0;
  let workdayRows = 0;
  const ruleVersions = new Set();
  const daysWithRows = new Set();
  let unjudgedDays = 0;

  for (const row of rows) {
    const status = String(row.status ?? '').trim();
    if (Object.prototype.hasOwnProperty.call(byStatus, status)) byStatus[status] += 1;

    const computation = String(row.computationStatus ?? row.computation_status ?? '').trim();
    if (Object.prototype.hasOwnProperty.call(byComputation, computation)) byComputation[computation] += 1;
    if (UNJUDGED_DAILY_STATUSES.includes(computation)) unjudgedDays += 1;

    if (String(row.dayClassification ?? '') === 'workday') workdayRows += 1;
    if (row.ruleVersionCode) ruleVersions.add(String(row.ruleVersionCode));
    const day = dayKeyOf(row.date);
    if (day) daysWithRows.add(day);

    totalLateMinutes += Number.isFinite(Number(row.lateMinutes)) ? Number(row.lateMinutes) : 0;
    totalEarlyMinutes += Number.isFinite(Number(row.earlyMinutes)) ? Number(row.earlyMinutes) : 0;
    totalWorkHours += Number.isFinite(Number(row.workDuration)) ? Number(row.workDuration) : 0;
  }

  // --- expected working days from the approved calendar --------------------
  // NULL means "cannot be derived", and the reason is recorded. It is never quietly zero: a zero would
  // read as "nobody was expected to work", which is a different and much stronger claim.
  const derivationNotes = [];
  let expectedWorkingDays = null;
  if (calendar.length === 0) {
    derivationNotes.push('calendar not supplied; expected_working_days not derived');
  } else {
    let workingDays = 0;
    let blocker = null;
    for (const day of calendar) {
      const dayKey = dayKeyOf(day?.date) || String(day?.date ?? '').slice(0, 10);
      if (!day.rule) {
        blocker = { reason: 'no_approved_rule', date: dayKey };
        break;
      }
      if (day.rule.workDays == null) {
        blocker = { reason: 'working_week_not_specified', date: dayKey };
        break;
      }
      const workDays = Array.isArray(day.rule.workDays) && day.rule.workDays.length > 0
        ? day.rule.workDays
        : DEFAULT_WORK_DAYS;
      const isWorkDay = workDays.includes(isoDayNumber(dayKey));
      // A rule that does not ignore holidays explicitly says holidays are worked.
      const holidayCounts = day.holiday === true && day.rule.ignoreHolidays !== false;
      if (isWorkDay && !holidayCounts) workingDays += 1;
    }
    if (blocker) {
      derivationNotes.push(`expected_working_days not derived: ${blocker.reason} on ${blocker.date}`);
    } else {
      expectedWorkingDays = workingDays;
    }
  }

  // --- the completeness verdict --------------------------------------------
  let computationStatus;
  if (rows.length === 0) {
    computationStatus = 'no_data';
    derivationNotes.push('no daily rows stored for this month');
  } else if (byComputation.pending_policy > 0) {
    // The blocker is a missing approved rule, so no amount of recalculation fixes the month until the
    // policy exists. Reported as its own status rather than buried in 'partial'.
    computationStatus = 'pending_policy';
  } else if (byComputation.insufficient_data > 0 || byComputation.failed > 0) {
    computationStatus = 'partial';
  } else {
    computationStatus = 'calculated';
  }

  // Days the approved calendar expects that have NO stored row at all. This is the reconciliation signal
  // and only computable when expected_working_days was derivable.
  const missingDays = expectedWorkingDays == null
    ? null
    : allDays.filter((day) => {
      const entry = calendar.find((candidate) => (dayKeyOf(candidate?.date) || '') === day);
      if (!entry || !entry.rule) return false;
      const workDays = Array.isArray(entry.rule.workDays) && entry.rule.workDays.length > 0
        ? entry.rule.workDays
        : DEFAULT_WORK_DAYS;
      const isWorkDay = workDays.includes(isoDayNumber(day));
      const holidayCounts = entry.holiday === true && entry.rule.ignoreHolidays !== false;
      return isWorkDay && !holidayCounts && !daysWithRows.has(day);
    });

  const sortedRules = Array.from(ruleVersions).sort();

  return {
    employeeUid,
    year,
    month,
    // pre-existing aggregate columns, preserved with the same meaning
    totalWorkDays: workdayRows,
    totalPresent: byStatus.present,
    totalLate: byStatus.late,
    totalAbsent: byStatus.absent,
    totalLeave: byStatus.leave,
    totalLateMinutes,
    totalWorkHours: round2(totalWorkHours),
    // Slice 3 additions
    totalEarlyMinutes,
    pendingDays: byStatus.pending,
    holidayDays: byStatus.holiday,
    expectedWorkingDays,
    computationStatus,
    ruleVersions: sortedRules,
    dayCounts: {
      rows: rows.length,
      byStatus,
      byComputationStatus: byComputation,
      unjudgedDays,
      daysWithRows: daysWithRows.size,
      missingWorkingDays: missingDays == null ? null : missingDays.length,
      ...(missingDays != null && missingDays.length > 0 ? { missingWorkingDayDates: missingDays } : {}),
    },
    derivationNotes: derivationNotes.length > 0 ? derivationNotes.join('; ') : null,
    calculatedAt: input.calculatedAt ?? null,
    sourceKind: 'derived_from_daily_attendance',
  };
}

module.exports = {
  MONTH_COMPUTATION_STATUS,
  DAILY_STATUS,
  UNJUDGED_DAILY_STATUSES,
  DEFAULT_WORK_DAYS,
  calculateMonthlySummary,
  assertPeriod,
  daysInMonth,
  enumerateMonthDays,
  isoDayNumber,
  monthKeyOf,
  dayKeyOf,
};
