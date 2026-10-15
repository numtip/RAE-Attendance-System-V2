/**
 * Slice 2: the daily attendance calculation service.
 *
 * It answers one question: "given the scans that were already attributed to this employee, the approved
 * rule version, the approved schedule, the approved holiday calendar and the verified leave facts, what is
 * this employee-day?" It then stores the answer WITH its provenance.
 *
 * Design rules that this file exists to enforce:
 *
 *  1. Deterministic. The same stored inputs always produce the same output. There is no clock read inside
 *     the calculation (the caller passes `calculatedAt`), no ordering ambiguity, and no random value. A
 *     recalculation therefore reproduces byte-identical numbers, which is what makes a historical report
 *     defensible.
 *
 *  2. Idempotent. `calculateDay` is safe to run repeatedly; the repository upserts on
 *     (employee_uid, date) and replaces the source-event links in the same transaction.
 *
 *  3. Historical ownership is preserved. Identity is NEVER re-resolved here: the service aggregates
 *     `attendance_events` rows by the `employee_uid` that was stamped at ingest time through the
 *     effective-dated mapping (Slice 1). If an employee code is later reused by someone else, a
 *     recalculation of an old period still attributes the old scans to the original employee.
 *
 *  4. Never fabricate. No approved rule covering the date yields `pending_policy`, not an assumed policy.
 *     Unreadable scans yield `insufficient_data`. Only `calculated` carries lateness conclusions.
 *
 *  5. Agent Core can never block or alter a calculation. The advisory hook at the end is optional, is not
 *     awaited for correctness, and its failure is swallowed into a diagnostic field.
 */
const { HttpError } = require('../utils/httpError');
const { calculateDailyAttendance } = require('../domain/dailyAttendanceCalculation');
const { normalizeValidityDate } = require('../domain/identifierValidity');
const { assertCanReadEmployee } = require('./access');
const { canonicalRole, ROLES, resolveScope } = require('./authorizationService');
const { wallDateOnly } = require('../utils/bangkokTime');
const { nextIsoDate } = require('../domain/dailyAttendanceCalculation');

/**
 * The caller may declare the source; when it does not, the engine derives it from the scans. There is no
 * hardcoded fallback, because a default would be an unverified claim about where the data came from.
 */
const DECLARED_SOURCE_SYSTEM = null;

/** Inclusive list of 'YYYY-MM-DD' between two dates. Pure string arithmetic via Date.UTC. */
function enumerateDates(from, to) {
  const dates = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return dates;
  for (let stamp = start; stamp <= end; stamp += 86_400_000) {
    dates.push(new Date(stamp).toISOString().slice(0, 10));
  }
  return dates;
}

/** The fields that represent a DECISION (not a timestamp). Used to decide whether a stored row is stale. */
const DECISION_FIELDS = Object.freeze([
  'status',
  'computationStatus',
  'dayClassification',
  'isLate',
  'lateMinutes',
  'earlyMinutes',
  'workDuration',
  'isLeave',
  'leaveType',
  'isOvernight',
  'sourceEventCount',
  'ruleVersionCode',
  'scheduleCode',
]);

function sameDecision(stored, fresh) {
  return DECISION_FIELDS.every((field) => stored?.[field] === fresh?.[field]);
}

function assertCanRecalculate(auth) {
  const role = canonicalRole(auth && auth.role);
  if (role === ROLES.ADMIN || role === ROLES.MANAGER) return role;
  throw new HttpError(403, 'FORBIDDEN', 'Attendance calculation requires a manager or admin role');
}

/**
 * Group scans by their Asia/Bangkok wall date.
 *
 * MUST use `wallDateOnly`, not `String(value).slice(0, 10)`: the MariaDB twin returns a JS `Date` for the
 * `event_time` DATETIME (the pool sets timezone 'Z'), and `String(new Date(...))` gives "Thu Sep 10", which
 * would never match an ISO date. That mismatch silently produced `absent` rows with no provenance.
 */
function groupEventsByDate(events) {
  const byDate = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const day = wallDateOnly(event?.eventTime);
    if (!day) continue;
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(event);
  }
  return byDate;
}

function createDailyAttendanceService({ repositories, agentAdvisory = null, now = () => new Date() } = {}) {
  const events = repositories.attendanceEvents;
  const daily = repositories.dailyAttendance;
  const rules = repositories.attendanceRules;
  const leaves = repositories.leave;

  async function loadDayInputs(employeeUid, date) {
    // The scan window is [date, date + 1] on purpose: a shift that starts on `date` may legitimately END
    // on the next calendar day, and the engine needs those early-morning scans as the departure. The engine
    // ignores them when the rule does not enable overnight shifts (counting them as `nextDayEventsIgnored`),
    // so widening the load cannot change a result on its own.
    const windowEnd = nextIsoDate(date) || date;
    const [dayEvents, rule, schedule, holiday, leaveRows] = await Promise.all([
      events.listForEmployeeRange({ employeeUid, from: date, to: windowEnd }),
      rules.findEffectiveRuleVersion(date),
      rules.findEffectiveSchedule(employeeUid, date),
      rules.findHolidayOn(date),
      leaves.list(employeeUid),
    ]);
    return { dayEvents, rule, schedule, holiday, leaveRows };
  }

  /**
   * Calculate one employee-day WITHOUT writing. Returns the row body plus a short explanation, so a
   * reviewer (and the API) can see why a day came out the way it did.
   */
  async function calculateDay({ employeeUid, date, sourceSystem = DECLARED_SOURCE_SYSTEM, calculatedAt = null }) {
    const isoDate = normalizeValidityDate(date, 'date');
    if (!isoDate) throw new HttpError(400, 'DAILY_CALC_INVALID_DATE', 'date is required');
    if (!employeeUid) throw new HttpError(400, 'DAILY_CALC_INVALID_EMPLOYEE', 'employeeUid is required');

    const {
      dayEvents, rule, schedule, holiday, leaveRows,
    } = await loadDayInputs(employeeUid, isoDate);

    const row = calculateDailyAttendance({
      employeeUid,
      date: isoDate,
      events: dayEvents,
      rule,
      schedule,
      holiday,
      leaveFacts: leaveRows,
      options: {
        sourceSystem: sourceSystem ?? null,
        calculatedAt: calculatedAt || now().toISOString(),
      },
    });

    // Diagnostics that must not leak into the stored row: what would have been available if the policy
    // had been approved, so an operator can act instead of guessing.
    const pendingRule = rule ? null : await rules.findEffectiveRuleVersionAnyStatus(isoDate);
    const pendingSchedule = schedule ? null : await rules.findEffectiveScheduleAnyStatus(employeeUid, isoDate);

    return {
      row,
      diagnosis: {
        date: isoDate,
        employeeUid,
        computationStatus: row.computationStatus,
        reason: row.reconciliationJson?.reason ?? null,
        rawEventCount: dayEvents.length,
        ruleVersionCode: rule ? rule.ruleVersionCode : null,
        rulePending: rule ? null : (pendingRule
          ? { ruleVersionCode: pendingRule.ruleVersionCode, status: pendingRule.status }
          : 'none_defined'),
        schedulePending: schedule ? null : (pendingSchedule
          ? { scheduleCode: pendingSchedule.scheduleCode, status: pendingSchedule.status }
          : null),
      },
    };
  }

  /** Calculate and store one employee-day. Idempotent. */
  async function calculateAndStore(args) {
    const { row, diagnosis } = await calculateDay(args);
    const stored = await daily.upsertDay(row);
    return { stored, diagnosis };
  }


  /**
   * Recalculate an inclusive date range for one employee, or for every employee that has scan activity in
   * the range. Deterministic and idempotent: re-running produces the same rows.
   */
  async function recalculateRange({
    employeeUid = null, from, to, sourceSystem = DECLARED_SOURCE_SYSTEM, actor = null, allowedUids = null,
  }) {
    const start = normalizeValidityDate(from, 'from');
    const end = normalizeValidityDate(to, 'to');
    if (!start || !end) {
      throw new HttpError(400, 'DAILY_CALC_INVALID_RANGE', 'from and to are required');
    }
    if (end < start) {
      throw new HttpError(400, 'DAILY_CALC_INVALID_RANGE', 'to must not be earlier than from');
    }

    const targetedUids = employeeUid
      ? [employeeUid]
      : await events.listEmployeeUidsWithEvents({ from: start, to: end });
    // `allowedUids === null` means "every target is permitted"; a Set restricts an organization-wide run to
    // the caller's resolved scope so the unscoped route cannot exceed what a scoped read would return.
    const targetUids = allowedUids == null
      ? targetedUids
      : targetedUids.filter((uid) => allowedUids.has(uid));

    // The window is widened by one day so an overnight departure is available to `date`. Events on later
    // days are never enumerated, so no extra row is written.
    const windowEnd = nextIsoDate(end) || end;
    const calculatedAt = now().toISOString();
    const days = [];
    const summary = {
      from: start,
      to: end,
      employees: targetUids.length,
      calculated: 0,
      noData: 0,
      insufficientData: 0,
      pendingPolicy: 0,
      failed: 0,
      dates: 0,
    };

    for (const uid of targetUids) {
      const rangeEvents = await events.listForEmployeeRange({ employeeUid: uid, from: start, to: windowEnd });
      const byDate = groupEventsByDate(rangeEvents);
      const leaveRows = await leaves.list(uid);

      for (const date of enumerateDates(start, end)) {
        summary.dates += 1;
        try {
          const [rule, schedule, holiday] = await Promise.all([
            rules.findEffectiveRuleVersion(date),
            rules.findEffectiveSchedule(uid, date),
            rules.findHolidayOn(date),
          ]);
          // The engine must see the next calendar day too: it is where an overnight departure lives. It
          // ignores those scans when the rule does not enable overnight shifts.
          const carryDate = nextIsoDate(date);
          const dayEvents = (byDate.get(date) || []).concat(carryDate ? (byDate.get(carryDate) || []) : []);
          const row = calculateDailyAttendance({
            employeeUid: uid,
            date,
            events: dayEvents,
            rule,
            schedule,
            holiday,
            leaveFacts: leaveRows,
            options: { sourceSystem, calculatedAt },
          });
          const stored = await daily.upsertDay(row);
          days.push(stored);
          if (row.computationStatus === 'calculated') summary.calculated += 1;
          else if (row.computationStatus === 'no_data') summary.noData += 1;
          else if (row.computationStatus === 'insufficient_data') summary.insufficientData += 1;
          else if (row.computationStatus === 'pending_policy') summary.pendingPolicy += 1;
          else summary.failed += 1;
        } catch (error) {
          // One bad day must not abort a range. The day is recorded as failed with its reason, and the
          // run continues so the operator sees the full picture instead of the first error.
          summary.failed += 1;
          days.push({
            employeeUid: uid,
            date,
            computationStatus: 'failed',
            error: { code: error.code || 'DAILY_CALC_FAILED', message: error.message },
          });
        }
      }
    }

    return { summary, days, actor, calculatedAt };
  }

  /**
   * Advisory only (Phase C). Agent Core may recommend how to QA a result; it can never change a number.
   * Not configured, timed out, or malformed -> the caller still gets its calculation untouched.
   */
  async function requestAdvisory({ summary, context = {} } = {}) {
    if (!agentAdvisory || typeof agentAdvisory.evaluate !== 'function') {
      return { available: false, reason: 'agent_advisory_not_configured' };
    }
    try {
      const result = await agentAdvisory.evaluate({
        useCase: 'pr_risk_review',
        context: { ...context, attendanceSummary: summary },
      });
      return { available: true, result };
    } catch (error) {
      // Never surfaced as a failure: core calculations must not depend on the advisory plane.
      return { available: false, reason: 'agent_advisory_unavailable', code: error?.code ?? null };
    }
  }

  return {
    async calculateDayForEmployee(auth, employeeUid, date) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'directory');
      const { row, diagnosis } = await calculateDay({ employeeUid, date });
      return { calculation: row, diagnosis };
    },

    async recalculate(auth, { employeeUid = null, from, to, sourceSystem }) {
      const role = assertCanRecalculate(auth);
      let allowedUids = null;
      if (employeeUid) {
        await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      } else {
        // An organization-wide rebuild must not be reachable by role alone. Reuse the same scope resolver
        // every other read uses, and require a BROAD data scope; otherwise the caller could rebuild and read
        // every employee's attendance just by omitting the parameter.
        const scope = await resolveScope(auth, repositories, 'data');
        if (!scope.all && !scope.broad) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'Organization-wide recalculation requires a broad data scope (an authorization grant)',
          );
        }
        allowedUids = scope.all ? null : scope.uids;
      }
      const result = await recalculateRange({
        employeeUid, from, to, sourceSystem, actor: auth?.employeeUid ?? null, allowedUids,
      });
      const advisory = await requestAdvisory({ summary: result.summary });
      return { ...result, role, advisory };
    },

    async getStored(auth, employeeUid, date) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const isoDate = normalizeValidityDate(date, 'date');
      return daily.findForEmployeeDate(employeeUid, isoDate);
    },

    async listStored(auth, { employeeUid, from, to }) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      return daily.listForRange({ employeeUid, from, to });
    },

    async explain(auth, employeeUid, date) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'directory');
      const { row, diagnosis } = await calculateDay({ employeeUid, date });
      const stored = await daily.findForEmployeeDate(employeeUid, normalizeValidityDate(date, 'date'));
      return {
        diagnosis,
        calculation: row,
        stored,
        // `stale` compares the DECISION, not the timestamps: `calculatedAt` necessarily differs because
        // this is a fresh run, so comparing it would report every row as stale and mean nothing.
        stale: stored ? !sameDecision(stored, row) : true,
      };
    },

    // exposed for tests and for the API layer
    recalculateRange,
    requestAdvisory,
    calculateAndStore,
    sameDecision,
  };
}

module.exports = { createDailyAttendanceService, enumerateDates, groupEventsByDate };
