const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const engine = require('../domain/attendanceRuleEngine');

/**
 * Attendance day write — the module that gives `daily_attendance` its first writer.
 *
 * Every staff-facing attendance read already existed while nothing in the repository could create
 * the rows they read: `daily_attendance` and `monthly_summary` had no writer at all (the schema is
 * migrated and idempotent, the approved rule engine is finished but imported by nothing). This
 * service closes that gap without a new migration and without the external Attendance Core:
 *
 *   evaluate one employee-day with AR-0001 -> upsert the day -> re-derive that employee-month
 *
 * Two rules are deliberately preserved:
 *   - there is no ABSENT: a day with no scan is `pending`/`no_data`, never `absent` (ADR-014);
 *   - a year without an approved rule set is not guessed: the day is stored as
 *     `pending`/`pending_policy` with a null rule version, so the record is honest rather than
 *     fabricated.
 */

// Provenance a human can actually claim by hand. Anything else (CSV_IMPORT, FACESCAN) must be
// produced by the importer that earned it, not by a caller naming it.
const ALLOWED_SOURCES = new Set(['MANUAL_CORRECTION']);
const LEAVE_TYPES = new Set(['sick', 'personal', 'vacation', 'other']);
const NOTE_MAX = 500;

function assertDate(date) {
  if (!engine.isCalendarDate(date)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
}

function assertTime(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be HH:MM`);
  }
  return value;
}

function minutesOf(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** A Bangkok wall-clock time on a given day, as an instant. The pool reads as UTC ('Z'), so storing
 *  the literal wall clock into DATETIME would shift every scan by seven hours. */
function instant(date, hhmm) {
  return hhmm ? new Date(`${date}T${hhmm}:00+07:00`) : null;
}

function workHours(checkIn, checkOut) {
  const start = minutesOf(checkIn);
  const end = minutesOf(checkOut);
  if (start == null || end == null || end <= start) return 0;
  return Math.round(((end - start) / 60) * 100) / 100;
}

/** Engine status -> the DB row. The engine's finer status is kept in reconciliation_json. */
function toDayRow({ employeeUid, date, checkIn, checkOut, leaveType, note, source, evaluation, context = {} }) {
  const [year, month] = date.split('-').map(Number);
  const isoWeekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const pendingPolicy = evaluation.pendingPolicy === true;
  const isWorkday = evaluation.isWorkday !== false;
  const dayClassification = isWorkday
    ? 'workday'
    : isoWeekday >= 6
      ? 'weekend'
      : 'holiday';

  const status = (() => {
    if (pendingPolicy) return 'pending';
    if (evaluation.status === engine.STATUS.HOLIDAY) return 'holiday';
    if (evaluation.status === engine.STATUS.LEAVE) return 'leave';
    if (evaluation.status === engine.STATUS.PRESENT) return 'present';
    // late_and_early_leave has no dedicated DB status: 'late' plus early_minutes carries it.
    if (evaluation.status === engine.STATUS.LATE) return 'late';
    if (evaluation.status === engine.STATUS.LATE_AND_EARLY_LEAVE) return 'late';
    if (evaluation.status === engine.STATUS.EARLY_LEAVE) return 'present';
    return 'pending'; // no_data
  })();

  const computationStatus = pendingPolicy
    ? 'pending_policy'
    : evaluation.status === engine.STATUS.NO_DATA
      ? 'no_data'
      : 'calculated';

  return {
    employeeUid,
    date,
    year,
    month,
    checkIn: instant(date, checkIn),
    checkOut: instant(date, checkOut),
    isLate: status === 'late' ? 1 : 0,
    lateMinutes: evaluation.lateMinutes || 0,
    earlyMinutes: evaluation.earlyLeaveMinutes || 0,
    workDuration: workHours(checkIn, checkOut),
    isLeave: status === 'leave' ? 1 : 0,
    leaveType: status === 'leave' ? leaveType : null,
    status,
    notes: note || null,
    sourceSystem: context.sourceSystem || 'API',
    ruleVersionCode: pendingPolicy ? null : evaluation.ruleVersion,
    computationStatus,
    dayClassification,
    isOvernight: 0,
    sourceEventCount: context.eventCount || 0,
    // A derived day knows the real first/last scan; a manual write only knows what was typed.
    firstEventAt: context.firstEventAt ? new Date(context.firstEventAt) : instant(date, checkIn),
    lastEventAt: context.lastEventAt ? new Date(context.lastEventAt) : instant(date, checkOut),
    calculatedAt: new Date(),
    reconciliation: JSON.stringify({
      engineStatus: pendingPolicy ? 'rule_year_not_approved' : evaluation.status,
      reasons: evaluation.reasons || [],
      earlyLeaveMinutes: evaluation.earlyLeaveMinutes || 0,
      source: context.source || source,
      submittedAt: new Date().toISOString(),
    }),
  };
}

function emptySummary(employeeUid, year, month) {
  return {
    employeeUid, year, month,
    totalWorkDays: 0, totalPresent: 0, totalLate: 0, totalAbsent: 0, totalLeave: 0,
    totalLateMinutes: 0, totalEarlyMinutes: 0, totalWorkHours: 0,
    computationStatus: 'no_data', ruleVersions: [], expectedWorkingDays: null,
    pendingDays: 0, holidayDays: 0, dayCounts: {}, derivationNotes: null,
    calculatedAt: new Date(), sourceKind: 'derived_from_daily_attendance',
  };
}

/** Weekdays in a month, from the calendar — not from an approved policy. */
function weekdaysIn(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = 1; day <= last; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}

function deriveSummary(employeeUid, year, month, rows) {
  const summary = emptySummary(employeeUid, year, month);
  const ruleVersions = new Set();
  const dayCounts = {};
  let pendingPolicy = false;

  for (const row of rows) {
    dayCounts[row.status] = (dayCounts[row.status] || 0) + 1;
    if (row.ruleVersionCode) ruleVersions.add(row.ruleVersionCode);
    if (row.computationStatus === 'pending_policy') pendingPolicy = true;
    if (row.status !== 'holiday' && row.status !== 'pending') summary.totalWorkDays += 1;
    if (row.status === 'present' || row.status === 'late') summary.totalPresent += 1;
    if (row.status === 'late') {
      summary.totalLate += 1;
      summary.totalLateMinutes += Number(row.lateMinutes || 0);
    }
    if (row.status === 'present' || row.status === 'late' || row.status === 'leave') {
      summary.totalEarlyMinutes += Number(row.earlyMinutes || 0);
    }
    if (row.status === 'leave') summary.totalLeave += 1;
    if (row.status === 'holiday') summary.holidayDays += 1;
    if (row.status === 'pending') summary.pendingDays += 1;
    summary.totalWorkHours += Number(row.workDuration || 0);
  }

  summary.totalWorkHours = Math.round(summary.totalWorkHours * 100) / 100;
  summary.ruleVersions = [...ruleVersions];
  summary.dayCounts = dayCounts;
  summary.expectedWorkingDays = pendingPolicy ? null : weekdaysIn(year, month);
  summary.computationStatus = pendingPolicy
    ? 'pending_policy'
    : rows.length === 0
      ? 'no_data'
      : summary.pendingDays > 0
        ? 'partial'
        : 'calculated';
  summary.derivationNotes = pendingPolicy
    ? 'At least one day in this period has no approved rule set; totals are recorded, not estimated.'
    : null;
  return summary;
}

/**
 * The one data-scope rule for writing someone's attendance. Exported because the facescan
 * derivation writes `attendance_events` before it can derive anything, and it must refuse an
 * out-of-scope caller *before* the first insert — with the same rule, not a second copy of it.
 */
async function assertCanRecordDay(auth, employeeUid, repositories) {
  const scope = await resolveScope(auth, repositories, 'data');
  // Two conditions, because each alone is wrong: a broad scope must still cover the target person
  // (a manager may not write for another org unit), and self-scope alone is never enough to write
  // (an employee cannot author their own attendance — that is an HR act, not a self service).
  const coversTarget = scope.all || scope.uids.has(employeeUid);
  if (!(scope.all || scope.broad) || !coversTarget) {
    throw new HttpError(403, 'FORBIDDEN', 'Recording attendance for this employee is outside your scope');
  }
}

function createAttendanceRecordService({ repositories }) {
  return {
    /**
     * POST /api/v1/attendance/daily/:employeeUid/:date
     * RBAC: writing another person's attendance needs data scope over that person. An EMPLOYEE has
     * self-read only, so they cannot author their own record — that is deliberate, not an oversight.
     */
    async recordDay(auth, employeeUid, date, body = {}, context = {}) {
      assertDate(date);
      const checkIn = assertTime(body.checkIn, 'checkIn');
      const checkOut = assertTime(body.checkOut, 'checkOut');
      const leave = body.leave === true;
      const source = body.source ?? 'MANUAL_CORRECTION';
      const leaveType = body.leaveType ?? null;
      const note = body.note ?? null;

      if (!checkIn && !checkOut && !leave) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'record at least one fact: checkIn, checkOut or leave');
      }
      if (!ALLOWED_SOURCES.has(source)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'source must be MANUAL_CORRECTION for a manual write');
      }
      if (leave && !LEAVE_TYPES.has(leaveType)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'leaveType is required when leave is true');
      }
      if (note !== null && String(note).length > NOTE_MAX) {
        throw new HttpError(400, 'VALIDATION_ERROR', `note must be at most ${NOTE_MAX} characters`);
      }

      await assertCanRecordDay(auth, employeeUid, repositories);

      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');

      let evaluation;
      try {
        const holidays = repositories.attendanceHolidays
          ? await repositories.attendanceHolidays.listApproved(date, date) : [];
        evaluation = engine.evaluateDay({ date, checkIn, checkOut, leave }, { holiday: holidays.length > 0 });
      } catch (error) {
        // A year with no approved rule set is recorded honestly instead of guessed.
        if (error && error.code === 'RULE_YEAR_NOT_APPROVED') {
          evaluation = {
            status: engine.STATUS.NO_DATA,
            isWorkday: true,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            ruleVersion: null,
            reasons: ['rule_year_not_approved'],
            pendingPolicy: true,
          };
        } else {
          throw error;
        }
      }

      const row = toDayRow({
        employeeUid, date, checkIn, checkOut, leaveType, note, source, evaluation, context,
      });
      await repositories.attendance.upsertDay(row);

      const monthRows = await repositories.attendance.findForEmployee(employeeUid);
      const inPeriod = monthRows.filter((item) => (
        String(item.date).slice(0, 7) === `${row.year}-${String(row.month).padStart(2, '0')}`
      ));
      const monthly = deriveSummary(employeeUid, row.year, row.month, inPeriod);
      if (monthly.expectedWorkingDays !== null && repositories.attendanceHolidays) {
        const start = `${row.year}-${String(row.month).padStart(2, '0')}-01`;
        const end = `${row.year}-${String(row.month).padStart(2, '0')}-${String(new Date(Date.UTC(row.year, row.month, 0)).getUTCDate()).padStart(2, '0')}`;
        const holidays = await repositories.attendanceHolidays.listApproved(start, end);
        const weekdays = new Set(holidays.map((item) => item.date).filter((day) => {
          const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
          return weekday > 0 && weekday < 6;
        }));
        monthly.expectedWorkingDays -= weekdays.size;
      }
      await repositories.attendance.upsertMonthly(monthly);

      return {
        employeeUid,
        date,
        status: row.status,
        isLate: row.isLate === 1,
        lateMinutes: row.lateMinutes,
        earlyMinutes: row.earlyMinutes,
        workDuration: row.workDuration,
        computationStatus: row.computationStatus,
        dayClassification: row.dayClassification,
        ruleVersionCode: row.ruleVersionCode,
        reasons: JSON.parse(row.reconciliation).reasons,
        monthly,
      };
    },
  };
}

module.exports = { createAttendanceRecordService, assertCanRecordDay, deriveSummary, weekdaysIn };
