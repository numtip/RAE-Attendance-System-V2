/**
 * R-04 reconciliation service: READ-ONLY snapshots that compare stored V2 facts against the records they
 * were derived from (scans, rules, identity windows, leave facts).
 *
 * Hard rules this file enforces:
 *
 *  1. READ-ONLY. It calls only read methods (`find*`, `list*`) on every repository. It never calls
 *     `upsert*`, `insert*` or `delete*`, and a test deep-snapshots every store before and after a run.
 *
 *  2. It COMPARES, it does not compute a new truth. Month totals are compared against the existing pure
 *     derivation in `monthlyAttendanceCalculation`; report totals come from the existing R-02
 *     `attendanceReportService`. Nothing here is a second attendance engine.
 *
 *  3. Identity is `employee_uid` plus effective-dated identifier/assignment windows. It NEVER joins by name
 *     or email. Ambiguity is flagged, never resolved, and a record is never reassigned to another employee.
 *
 *  4. Deterministic. No clock read inside a comparison: the caller's `now` is read ONCE per call to stamp
 *     `asOf`/`cutoff`, and the `snapshotHash` is built from a canonical body that EXCLUDES those
 *     `now`-derived timestamps (otherwise identical data hashes differently on every run).
 *
 *  5. No PII beyond what reconciliation needs. Presented rows omit internal row ids, `sourceEventIds`,
 *     national ids, HMAC values, tokens and facescan ids. Raw scan rows are never emitted — only counts
 *     and wall timestamps.
 *
 *  6. Authorization runs through the SAME resolver R-02 uses (`assertCanReadEmployee`), BEFORE the
 *     employee-existence check and BEFORE any data read, so the two cannot drift.
 */
const { createHash } = require('node:crypto');

const { HttpError } = require('../utils/httpError');
const { wallDateOnly, formatBangkokWall } = require('../utils/bangkokTime');
const { assertCanReadEmployee } = require('./access');
const { createAttendanceReportService } = require('./attendanceReportService');
const {
  calculateMonthlySummary,
  enumerateMonthDays,
} = require('../domain/monthlyAttendanceCalculation');
const { isEffectiveOnDate } = require('../domain/identifierValidity');
const { isEffectiveOn } = require('../domain/employeeAssignment');
const { isWorkDay, DEFAULT_WORK_DAYS } = require('../domain/attendanceRule');
const { splitWallDateTime, findVerifiedLeave } = require('../domain/dailyAttendanceCalculation');
const { fiscalYearPeriod } = require('../domain/reconciliationPeriod');
const {
  REAL_SOURCE_NOTE,
  verdictOf,
  countCheckStatuses,
  unresolvedChecks,
  statusReasonsOf,
  evaluateDayChecks,
  evaluatePeriodChecks,
  evaluateFiscalChecks,
} = require('../domain/reconciliation');

const DAY_FINAL_STATUSES = Object.freeze(['calculated', 'no_data']);
const UNJUDGED_STATUSES = Object.freeze(['pending_policy', 'insufficient_data', 'failed']);

const SOURCE_TABLES = Object.freeze([
  'attendance_events',
  'attendance_rule_versions',
  'daily_attendance',
  'employee_assignments',
  'employee_identifiers',
  'employee_leave',
  'monthly_summaries',
]);

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

function invalidPeriod(message) {
  return new HttpError(400, 'RECONCILIATION_INVALID_PERIOD', message);
}

function assertMonth(year, month) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (!Number.isInteger(parsedYear) || parsedYear < MIN_YEAR || parsedYear > MAX_YEAR) {
    throw invalidPeriod('year must be an integer between 2000 and 2100');
  }
  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw invalidPeriod('month must be an integer between 1 and 12');
  }
  return { year: parsedYear, month: parsedMonth };
}

function assertIsoDay(value) {
  const iso = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw invalidPeriod('date must be a real ISO date (YYYY-MM-DD)');
  const [, year, month, day] = match.map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  if (!real) throw invalidPeriod('date must be a real ISO date (YYYY-MM-DD)');
  return iso;
}

/** Deterministic JSON with recursively sorted object keys, so two identical bodies hash identically. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function snapshotHashOf(body) {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

// --- PII-free presenters ----------------------------------------------------

function presentCanonicalDay(row) {
  if (!row) return null;
  return {
    date: wallDateOnly(row.date),
    status: row.status ?? null,
    computationStatus: row.computationStatus ?? null,
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
    firstEventAt: row.firstEventAt ?? null,
    lastEventAt: row.lastEventAt ?? null,
    calculatedAt: row.calculatedAt ?? null,
  };
}

function presentCanonicalMonth(row) {
  if (!row) return null;
  return {
    year: row.year,
    month: row.month,
    computationStatus: row.computationStatus ?? null,
    totalWorkDays: row.totalWorkDays,
    totalPresent: row.totalPresent,
    totalLate: row.totalLate,
    totalAbsent: row.totalAbsent,
    totalLeave: row.totalLeave,
    totalLateMinutes: row.totalLateMinutes,
    totalEarlyMinutes: row.totalEarlyMinutes,
    totalWorkHours: row.totalWorkHours,
    pendingDays: row.pendingDays,
    holidayDays: row.holidayDays,
    expectedWorkingDays: row.expectedWorkingDays ?? null,
    ruleVersions: Array.isArray(row.ruleVersions) ? [...row.ruleVersions] : [],
    calculatedAt: row.calculatedAt ?? null,
  };
}

/** An event reduced to the two facts reconciliation compares; never the row id or the facescan id. */
function presentEvent(event) {
  const { date, time } = splitWallDateTime(event?.eventTime);
  if (!date || !time) return null;
  return { wall: `${date} ${time}`, checkType: event.checkType ?? null };
}

function eventKey(event) {
  return `${event.wall}|${event.checkType ?? ''}`;
}

function unionOf(...lists) {
  const set = new Set();
  for (const list of lists) {
    for (const value of list || []) {
      if (value != null && value !== '') set.add(String(value));
    }
  }
  return Array.from(set).sort();
}

function createReconciliationService({ repositories, now = () => new Date() } = {}) {
  const daily = repositories.dailyAttendance;
  const summaries = repositories.monthlySummaries;
  const rules = repositories.attendanceRules;
  const employees = repositories.employees;
  const leaves = repositories.leave;
  const events = repositories.attendanceEvents;
  const identifiers = repositories.employeeIdentifiers;
  const assignments = repositories.employeeAssignments;
  const reportService = createAttendanceReportService({ repositories, now });

  const eventsAvailable = Boolean(events && typeof events.listForEmployeeRange === 'function');

  /** Scope first, existence second: a caller outside the scope must not learn whether the id exists. */
  async function assertReadable(auth, employeeUid) {
    await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
    if (!employees || typeof employees.findByUid !== 'function') return;
    const employee = await employees.findByUid(employeeUid);
    if (!employee) throw new HttpError(404, 'RECONCILIATION_UNKNOWN_EMPLOYEE', 'Employee was not found');
  }

  async function readEventsForDay(employeeUid, date) {
    if (!eventsAvailable) {
      return {
        available: false, attributed: [], uniqueCount: 0, unattributedCount: null, foreignCount: 0,
      };
    }
    const mine = await events.listForEmployeeRange({ employeeUid, from: date, to: date });
    const attributed = (Array.isArray(mine) ? mine : []).map(presentEvent).filter(Boolean);
    const uniqueCount = new Set(attributed.map(eventKey)).size;

    let foreignCount = 0;
    if (typeof events.listEmployeeUidsWithEvents === 'function') {
      const uids = await events.listEmployeeUidsWithEvents({ from: date, to: date });
      for (const uid of uids || []) {
        if (uid === employeeUid) continue;
        const rows = await events.listForEmployeeRange({ employeeUid: uid, from: date, to: date });
        foreignCount += Array.isArray(rows) ? rows.length : 0;
      }
    }

    // Unattributed scans (no employee at all) are only visible through the optional diagnostic hook. When
    // it is absent the check is honestly reported as INCOMPLETE rather than assumed to be zero.
    let unattributedCount = null;
    if (typeof events.all === 'function') {
      const all = await events.all();
      unattributedCount = (Array.isArray(all) ? all : [])
        .filter((row) => row && row.employeeUid == null && wallDateOnly(row.eventTime) === date).length;
    }

    return { available: true, attributed, uniqueCount, unattributedCount, foreignCount };
  }

  function identifierKeyOf(row) {
    if (!row || row.idValue == null) return null;
    return `${row.idType}|${row.idValue}`;
  }

  /** Cross-employee conflict on a date: a shared identifier value or employee_code held by two people. */
  async function detectIdentityConflict(employeeUid, date) {
    if (identifiers && typeof identifiers.all === 'function') {
      const all = await identifiers.all();
      const targetKeys = new Set(
        (all || [])
          .filter((row) => row.employeeUid === employeeUid && row.status === 'active' && isEffectiveOnDate(row, date))
          .map(identifierKeyOf)
          .filter(Boolean),
      );
      if (targetKeys.size > 0) {
        const clash = (all || []).some((row) => row.employeeUid !== employeeUid
          && row.status === 'active'
          && isEffectiveOnDate(row, date)
          && targetKeys.has(identifierKeyOf(row)));
        if (clash) return true;
      }
    }
    if (assignments && typeof assignments.all === 'function') {
      const all = await assignments.all();
      const targetCodes = new Set(
        (all || [])
          .filter((row) => row.employeeUid === employeeUid && isEffectiveOn(row, date))
          .map((row) => row.employeeCode),
      );
      if (targetCodes.size > 0) {
        const clash = (all || []).some((row) => row.employeeUid !== employeeUid
          && isEffectiveOn(row, date)
          && targetCodes.has(row.employeeCode));
        if (clash) return true;
      }
    }
    return false;
  }

  async function readIdentity(employeeUid, date) {
    const identifiersAvailable = Boolean(identifiers && typeof identifiers.listByEmployeeUid === 'function');
    let effectiveIdentifierCount = 0;
    if (identifiersAvailable) {
      const rows = await identifiers.listByEmployeeUid(employeeUid, { includeInactive: false });
      effectiveIdentifierCount = (rows || []).filter((row) => isEffectiveOnDate(row, date)).length;
    }
    let assignmentCount = 0;
    if (assignments && typeof assignments.listByEmployeeUid === 'function') {
      const rows = await assignments.listByEmployeeUid(employeeUid, { onDate: date });
      assignmentCount = (rows || []).length;
    }
    const conflict = await detectIdentityConflict(employeeUid, date);
    return {
      available: identifiersAvailable || Boolean(assignments),
      effectiveIdentifierCount,
      assignmentCount,
      assignmentAmbiguous: assignmentCount > 1,
      conflict,
    };
  }

  async function readRule(date) {
    if (!rules || typeof rules.findEffectiveRuleVersion !== 'function') {
      return { approved: null, anyStatus: null };
    }
    const approved = await rules.findEffectiveRuleVersion(date);
    if (approved) return { approved, anyStatus: null };
    const anyStatus = typeof rules.findEffectiveRuleVersionAnyStatus === 'function'
      ? await rules.findEffectiveRuleVersionAnyStatus(date)
      : null;
    return { approved: null, anyStatus };
  }

  async function readLeave(employeeUid, date) {
    if (!leaves || typeof leaves.list !== 'function') {
      return { sourceAvailable: false, verifiedCount: 0 };
    }
    const rows = await leaves.list(employeeUid);
    const { leave, candidateCount } = findVerifiedLeave(rows, date);
    return { sourceAvailable: true, verifiedCount: leave ? Math.max(1, candidateCount) : 0 };
  }

  // -------------------------------------------------------------------------
  // day
  // -------------------------------------------------------------------------

  async function buildDaySnapshot(employeeUid, date) {
    const [canonicalRow, dayEvents, identity, ruleRef, holiday] = await Promise.all([
      daily.findForEmployeeDate(employeeUid, date),
      readEventsForDay(employeeUid, date),
      readIdentity(employeeUid, date),
      readRule(date),
      typeof rules?.findHolidayOn === 'function' ? rules.findHolidayOn(date) : Promise.resolve(null),
    ]);
    const leave = await readLeave(employeeUid, date);

    const canonical = presentCanonicalDay(canonicalRow);
    const workDays = ruleRef.approved?.workDays ?? DEFAULT_WORK_DAYS;
    const workDayExpected = ruleRef.approved ? isWorkDay(workDays, date) : null;

    const observation = {
      employeeUid,
      date,
      canonical,
      events: dayEvents,
      identity,
      rule: ruleRef,
      holiday: Boolean(holiday),
      leave: { ...leave, canonicalIsLeave: canonical?.isLeave === true },
      workDayExpected,
    };
    const checks = evaluateDayChecks(observation);
    const status = verdictOf(checks);

    const judgedDays = canonical && DAY_FINAL_STATUSES.includes(String(canonical.computationStatus)) ? 1 : 0;
    const unjudgedDays = canonical && UNJUDGED_STATUSES.includes(String(canonical.computationStatus)) ? 1 : 0;

    const body = {
      kind: 'day',
      period: { from: date, to: date, date },
      population: { employees: 1, employeeUid, dayRows: canonical ? 1 : 0 },
      sourceTables: [...SOURCE_TABLES],
      ruleVersions: unionOf(
        canonical?.ruleVersionCode ? [canonical.ruleVersionCode] : [],
        ruleRef.approved?.ruleVersionCode ? [ruleRef.approved.ruleVersionCode] : [],
      ),
      status,
      statusReasons: statusReasonsOf(checks),
      checks,
      counts: countCheckStatuses(checks),
      unresolvedExceptions: unresolvedChecks(checks),
      completeness: {
        judgedDays,
        unjudgedDays,
        missingDays: canonical ? 0 : 1,
        expectedWorkingDays: workDayExpected === true ? 1 : 0,
      },
      realSourceVerified: false,
      realSourceNote: REAL_SOURCE_NOTE,
      pristine: true,
      detail: {
        day: canonical,
        events: {
          attributedCount: dayEvents.attributed.length,
          uniqueCount: dayEvents.uniqueCount,
          foreignCount: dayEvents.foreignCount,
          unattributedCount: dayEvents.unattributedCount,
        },
      },
    };

    return { body, status, checks };
  }

  async function finalize({ auth, employeeUid, body, stamp }) {
    const asOf = stamp.toISOString();
    const cutoff = wallDateOnly(formatBangkokWall(stamp));
    // The hash input EXCLUDES asOf and cutoff (both derived from `now`) and the hash itself, so identical
    // data produces an identical hash on every run. `detail`/`checks`/`period` remain included.
    const hashBody = {
      kind: body.kind,
      period: body.period,
      population: body.population,
      sourceTables: body.sourceTables,
      ruleVersions: body.ruleVersions,
      status: body.status,
      statusReasons: body.statusReasons,
      checks: body.checks,
      counts: body.counts,
      unresolvedExceptions: body.unresolvedExceptions,
      completeness: body.completeness,
      realSourceVerified: body.realSourceVerified,
      realSourceNote: body.realSourceNote,
      pristine: body.pristine,
      detail: body.detail,
    };
    return {
      snapshot: {
        ...body,
        asOf,
        cutoff,
        snapshotHash: snapshotHashOf(hashBody),
      },
      auth: auth.employeeUid,
      employeeUid,
    };
  }

  // -------------------------------------------------------------------------
  // month
  // -------------------------------------------------------------------------

  async function buildMonthObservation(employeeUid, year, month, auth) {
    const days = enumerateMonthDays(year, month);
    const bounds = { from: days[0], to: days[days.length - 1] };
    const [canonicalMonth, dailyRows] = await Promise.all([
      summaries.findForEmployeeMonth(employeeUid, year, month),
      daily.listForRange({ employeeUid, from: bounds.from, to: bounds.to }),
    ]);

    const calendar = [];
    for (const date of days) {
      const [rule, holiday] = await Promise.all([
        typeof rules?.findEffectiveRuleVersion === 'function' ? rules.findEffectiveRuleVersion(date) : Promise.resolve(null),
        typeof rules?.findHolidayOn === 'function' ? rules.findHolidayOn(date) : Promise.resolve(null),
      ]);
      calendar.push({
        date,
        rule: rule ? { workDays: rule.workDays ?? null, ignoreHolidays: rule.ignoreHolidays !== false } : null,
        holiday: Boolean(holiday),
      });
    }

    const derived = calculateMonthlySummary({
      employeeUid, year, month, dailyRows, calendar, calculatedAt: null,
    });

    let eventsEmployeeCount = 0;
    let targetHasEvents = false;
    if (eventsAvailable && typeof events.listEmployeeUidsWithEvents === 'function') {
      const uids = await events.listEmployeeUidsWithEvents({ from: bounds.from, to: bounds.to });
      eventsEmployeeCount = (uids || []).length;
      targetHasEvents = (uids || []).includes(employeeUid);
    }
    let rowEmployeeCount = 0;
    let targetHasRows = false;
    if (typeof daily.listEmployeeUidsWithDailyRows === 'function') {
      const uids = await daily.listEmployeeUidsWithDailyRows({ from: bounds.from, to: bounds.to });
      rowEmployeeCount = (uids || []).length;
      targetHasRows = (uids || []).includes(employeeUid);
    } else {
      targetHasRows = dailyRows.length > 0;
      rowEmployeeCount = targetHasRows ? 1 : 0;
    }

    let reportTotals = null;
    try {
      const report = await reportService.monthReport(auth, employeeUid, year, month);
      reportTotals = report?.month ?? null;
    } catch {
      reportTotals = null;
    }

    const missingWorkingDays = derived.dayCounts?.missingWorkingDayDates ?? [];
    return {
      canonicalMonth,
      dailyRows,
      derived,
      bounds,
      days,
      observation: {
        canonicalMonth,
        derived,
        eventsAvailable,
        targetHasEvents,
        targetHasRows,
        eventsEmployeeCount,
        rowEmployeeCount,
        missingWorkingDays,
        unjudgedDays: derived.dayCounts?.unjudgedDays ?? 0,
        reportTotals,
      },
    };
  }

  function presentMonthDetail(built) {
    return {
      days: built.dailyRows.map(presentCanonicalDay),
      month: presentCanonicalMonth(built.canonicalMonth),
      missingWorkingDays: built.derived.dayCounts?.missingWorkingDayDates ?? [],
    };
  }

  async function buildMonthSnapshot(employeeUid, year, month, auth) {
    const built = await buildMonthObservation(employeeUid, year, month, auth);
    const checks = evaluatePeriodChecks(built.observation);
    const status = verdictOf(checks);
    const derived = built.derived;
    const unjudgedDays = derived.dayCounts?.unjudgedDays ?? 0;

    const body = {
      kind: 'month',
      period: {
        from: built.bounds.from,
        to: built.bounds.to,
        year,
        month,
        key: `${year}-${String(month).padStart(2, '0')}`,
      },
      population: { employees: 1, employeeUid, dayRows: built.dailyRows.length },
      sourceTables: [...SOURCE_TABLES],
      ruleVersions: unionOf(
        built.canonicalMonth?.ruleVersions,
        built.dailyRows.map((row) => row.ruleVersionCode),
      ),
      status,
      statusReasons: statusReasonsOf(checks),
      checks,
      counts: countCheckStatuses(checks),
      unresolvedExceptions: unresolvedChecks(checks),
      completeness: {
        judgedDays: Math.max(0, (derived.dayCounts?.rows ?? 0) - unjudgedDays),
        unjudgedDays,
        missingDays: Array.isArray(derived.dayCounts?.missingWorkingDayDates)
          ? derived.dayCounts.missingWorkingDayDates.length
          : 0,
        expectedWorkingDays: derived.expectedWorkingDays ?? null,
      },
      realSourceVerified: false,
      realSourceNote: REAL_SOURCE_NOTE,
      pristine: true,
      detail: presentMonthDetail(built),
    };

    return body;
  }

  // -------------------------------------------------------------------------
  // fiscal year
  // -------------------------------------------------------------------------

  async function buildFiscalSnapshot(employeeUid, fiscalYear, auth, cutoff) {
    const period = fiscalYearPeriod(fiscalYear);

    let eventsEmployeeCount = 0;
    let targetHasEvents = false;
    if (eventsAvailable && typeof events.listEmployeeUidsWithEvents === 'function') {
      const uids = await events.listEmployeeUidsWithEvents({ from: period.from, to: period.to });
      eventsEmployeeCount = (uids || []).length;
      targetHasEvents = (uids || []).includes(employeeUid);
    }
    let rowEmployeeCount = 0;
    let targetHasRows = false;
    if (typeof daily.listEmployeeUidsWithDailyRows === 'function') {
      const uids = await daily.listEmployeeUidsWithDailyRows({ from: period.from, to: period.to });
      rowEmployeeCount = (uids || []).length;
      targetHasRows = (uids || []).includes(employeeUid);
    }

    const months = [];
    const detailMonths = [];
    for (const entry of period.months) {
      const built = await buildMonthObservation(employeeUid, entry.year, entry.month, auth);
      const started = built.bounds.from <= cutoff;
      months.push({
        key: `${entry.year}-${String(entry.month).padStart(2, '0')}`,
        started,
        hasCanonicalMonth: built.canonicalMonth != null,
        unjudgedDays: built.derived.dayCounts?.unjudgedDays ?? 0,
        missingWorkingDays: built.derived.dayCounts?.missingWorkingDayDates ?? [],
        storedTotals: built.canonicalMonth,
        derivedTotals: built.derived,
        reportTotals: built.observation.reportTotals,
        storedExpected: built.canonicalMonth?.expectedWorkingDays ?? null,
        derivedExpected: built.derived.expectedWorkingDays ?? null,
      });
      detailMonths.push({
        key: `${entry.year}-${String(entry.month).padStart(2, '0')}`,
        started,
        month: presentCanonicalMonth(built.canonicalMonth),
        dayRows: built.dailyRows.length,
        missingWorkingDays: built.derived.dayCounts?.missingWorkingDayDates ?? [],
      });
    }

    const checks = evaluateFiscalChecks({
      eventsAvailable,
      targetHasEvents,
      targetHasRows,
      eventsEmployeeCount,
      rowEmployeeCount,
      months,
    });
    const status = verdictOf(checks);

    const body = {
      kind: 'fiscal_year',
      period: {
        from: period.from,
        to: period.to,
        fiscalYear: period.fiscalYear,
        fiscalYearStartMonth: period.fiscalYearStartMonth,
        gregorianFrom: period.gregorianFrom,
        gregorianTo: period.gregorianTo,
        labelTh: period.labelTh,
      },
      population: { employees: 1, employeeUid, months: period.months.length },
      sourceTables: [...SOURCE_TABLES],
      ruleVersions: unionOf(...months.map((entry) => entry.storedTotals?.ruleVersions)),
      status,
      statusReasons: statusReasonsOf(checks),
      checks,
      counts: countCheckStatuses(checks),
      unresolvedExceptions: unresolvedChecks(checks),
      completeness: {
        judgedDays: null,
        unjudgedDays: months.reduce((total, entry) => total + (entry.started ? entry.unjudgedDays : 0), 0),
        missingDays: months.reduce(
          (total, entry) => total + (entry.started && Array.isArray(entry.missingWorkingDays)
            ? entry.missingWorkingDays.length : 0),
          0,
        ),
        expectedWorkingDays: months.every((entry) => entry.storedExpected == null)
          ? null
          : months.reduce((total, entry) => total + Number(entry.storedExpected || 0), 0),
      },
      realSourceVerified: false,
      realSourceNote: REAL_SOURCE_NOTE,
      pristine: true,
      detail: { months: detailMonths, startedMonths: months.filter((entry) => entry.started).map((entry) => entry.key) },
    };

    return body;
  }

  return {
    /** One employee-day reconciliation snapshot. Read-only. */
    async reconcileDay(auth, { employeeUid, date } = {}) {
      const isoDate = assertIsoDay(date);
      await assertReadable(auth, employeeUid);
      const stamp = now();
      const { body } = await buildDaySnapshot(employeeUid, isoDate);
      return finalize({ auth, employeeUid, body, stamp });
    },

    /** One employee-month reconciliation snapshot. Read-only. */
    async reconcileMonth(auth, { employeeUid, year, month } = {}) {
      const period = assertMonth(year, month);
      await assertReadable(auth, employeeUid);
      const stamp = now();
      const body = await buildMonthSnapshot(employeeUid, period.year, period.month, auth);
      return finalize({ auth, employeeUid, body, stamp });
    },

    /** One employee fiscal year (Oct-Sep, Buddhist Era) reconciliation snapshot. Read-only. */
    async reconcileFiscalYear(auth, { employeeUid, fiscalYear } = {}) {
      const period = fiscalYearPeriod(fiscalYear);
      await assertReadable(auth, employeeUid);
      const stamp = now();
      const cutoff = wallDateOnly(formatBangkokWall(stamp));
      const body = await buildFiscalSnapshot(employeeUid, period.fiscalYear, auth, cutoff);
      return finalize({ auth, employeeUid, body, stamp });
    },

    // exposed for reuse/tests
    assertReadable,
  };
}

module.exports = {
  createReconciliationService,
  presentCanonicalDay,
  presentCanonicalMonth,
  stableStringify,
};
