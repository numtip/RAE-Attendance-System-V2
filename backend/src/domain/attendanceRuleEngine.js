/**
 * In-repo attendance rule engine — ISOLATED groundwork for D-10.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT
 * ---------------------------------------
 * The owner approved the in-repo rule-engine direction for D-10, but the current calculation path must not
 * change until the engine is proven. This module is therefore **pure and unwired**: no service imports it, no
 * route calls it, and nothing in `attendanceComputeService`/`attendanceCoreClient` was touched. Landing it
 * changes zero behaviour; it gives the seven blocked slices one place to converge on.
 *
 * RULES — where they come from, exactly
 * -------------------------------------
 * `AR-0001`, approved 2026-10-16 (docs/memory/DECISIONS.md, D-E): work 08:30–16:30, **late after 08:30**,
 * **early before 16:30**, Monday–Friday, 2026 calendar year. `AR-0002` (2027) is NOT approved, so this module
 * refuses a date outside the approved year rather than assuming the next year looks the same.
 *
 * There is deliberately **no ABSENT status**: the approved rules describe what a scan means, not what a
 * missing scan means. Absence is a HR decision with its own evidence, so the engine reports `no_data` and lets
 * a human decide — the "ไม่มี ABSENT" rule.
 *
 * Times are `HH:MM` strings in Asia/Bangkok wall-clock and are compared as minutes-of-day. No Date objects, no
 * timezone arithmetic, no database: that is what makes this testable without a container.
 */

const RULE_VERSION = 'AR-0001';
const POLICY_YEAR = 2026;

const POLICY = Object.freeze({
  version: RULE_VERSION,
  year: POLICY_YEAR,
  workStart: '08:30',
  workEnd: '16:30',
  // ISO weekday numbers that are worked. 1 = Monday ... 7 = Sunday.
  workdays: Object.freeze([1, 2, 3, 4, 5]),
});

const STATUS = Object.freeze({
  PRESENT: 'present',
  LATE: 'late',
  EARLY_LEAVE: 'early_leave',
  LATE_AND_EARLY_LEAVE: 'late_and_early_leave',
  LEAVE: 'leave',
  HOLIDAY: 'holiday',
  NO_DATA: 'no_data',
});

function minutesOfDay(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''));
  if (!match) {
    const error = new Error('RULE_INPUT_INVALID: a time must be HH:MM (24h)');
    error.code = 'RULE_INPUT_INVALID';
    throw error;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** ISO weekday from a `YYYY-MM-DD` string, without constructing a local Date. */
function isoWeekday(dateOnly) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly ?? ''));
  if (!match) {
    const error = new Error('RULE_INPUT_INVALID: a date must be YYYY-MM-DD');
    error.code = 'RULE_INPUT_INVALID';
    throw error;
  }
  const [, year, month, day] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const weekday = new Date(utc).getUTCDay(); // 0 = Sunday
  return weekday === 0 ? 7 : weekday;
}

function assertPolicyYear(dateOnly) {
  const year = Number(String(dateOnly).slice(0, 4));
  if (year !== POLICY.year) {
    const error = new Error(
      `RULE_YEAR_NOT_APPROVED: ${year} has no approved rule set (only ${POLICY.year} / ${RULE_VERSION} is approved)`,
    );
    error.code = 'RULE_YEAR_NOT_APPROVED';
    throw error;
  }
}

/**
 * Evaluates one employee-day.
 *
 * @param {{date: string, checkIn?: string|null, checkOut?: string|null, leave?: boolean}} input
 * @param {{policy?: typeof POLICY}} options
 * @returns {{status: string, isWorkday: boolean, lateMinutes: number, earlyLeaveMinutes: number,
 *            ruleVersion: string, reasons: string[]}}
 */
function evaluateDay(input, options = {}) {
  const policy = options.policy || POLICY;
  const { date, checkIn = null, checkOut = null, leave = false } = input || {};
  assertPolicyYear(date);

  const weekday = isoWeekday(date);
  const isWorkday = policy.workdays.includes(weekday);
  const reasons = [];
  const result = {
    status: STATUS.NO_DATA,
    isWorkday,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    ruleVersion: policy.version,
    reasons,
  };

  if (!isWorkday) {
    result.status = STATUS.HOLIDAY;
    reasons.push('non_workday');
    return result;
  }
  if (leave) {
    result.status = STATUS.LEAVE;
    reasons.push('approved_leave');
    return result;
  }
  if (checkIn == null && checkOut == null) {
    // Not ABSENT: the approved rules say nothing about a missing scan. A human decides.
    reasons.push('no_scan');
    return result;
  }

  const start = minutesOfDay(policy.workStart);
  const end = minutesOfDay(policy.workEnd);
  if (checkIn != null) {
    const late = minutesOfDay(checkIn) - start;
    if (late > 0) {
      result.lateMinutes = late;
      reasons.push('late_after_work_start');
    }
  }
  if (checkOut != null) {
    const early = end - minutesOfDay(checkOut);
    if (early > 0) {
      result.earlyLeaveMinutes = early;
      reasons.push('early_before_work_end');
    }
  }

  if (result.lateMinutes > 0 && result.earlyLeaveMinutes > 0) result.status = STATUS.LATE_AND_EARLY_LEAVE;
  else if (result.lateMinutes > 0) result.status = STATUS.LATE;
  else if (result.earlyLeaveMinutes > 0) result.status = STATUS.EARLY_LEAVE;
  else {
    result.status = STATUS.PRESENT;
    reasons.push('within_window');
  }
  return result;
}

module.exports = {
  RULE_VERSION,
  POLICY,
  STATUS,
  minutesOfDay,
  isoWeekday,
  evaluateDay,
};
