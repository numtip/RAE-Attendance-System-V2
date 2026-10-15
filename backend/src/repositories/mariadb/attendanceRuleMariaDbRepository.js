/**
 * MariaDB twin of the attendance rule repositories (migration 022). Every query is parameter-bound.
 *
 * `mapRow` only formats a fixed set of date keys, so TIME columns (workStart/workEnd/lateAfter/earlyBefore),
 * the DATE columns (effectiveFrom/effectiveTo/holidayDate) and the JSON columns are coerced here.
 * Driver errors are mapped to the same coded HttpErrors the fixture twin throws, so callers cannot tell
 * the twins apart.
 */
const { HttpError } = require('../../utils/httpError');
const { mapRow } = require('./rowMapper');
const {
  RULE_STATUS,
  normalizeRuleVersionInput,
  normalizeScheduleInput,
  normalizeHolidayInput,
  normalizeTimeRow,
  normalizeEffectiveDate,
} = require('../../domain/attendanceRule');

const RULE_COLUMNS = `rule_version_code, name, status, effective_from, effective_to, work_start, work_end,
  late_after, early_before, overnight_shift, max_shift_span_minutes, ignore_holidays, work_days_json,
  leave_types_json, leave_aliases_json, business_statuses_json, source_of_truth,
  approved_by, approved_at, notes, created_at, updated_at`;

const HOLIDAY_COLUMNS = `id, holiday_date, name, scope, org_unit_code, status, source_system,
  source_reference, approved_by, approved_at, created_at, updated_at`;

const SCHEDULE_COLUMNS = `schedule_code, employee_uid, name, status, effective_from, effective_to,
  work_start, work_end, late_after, early_before, work_days_json, overnight_shift, source_system,
  source_reference, approved_by, approved_at, created_at, updated_at`;

const INSERT_RULE_SQL = `INSERT INTO attendance_rule_version (
    rule_version_code, name, status, effective_from, effective_to, work_start, work_end,
    late_after, early_before, overnight_shift, max_shift_span_minutes, ignore_holidays, work_days_json,
    leave_types_json, leave_aliases_json, business_statuses_json, source_of_truth,
    approved_by, approved_at, notes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_HOLIDAY_SQL = `INSERT INTO attendance_holiday (
    holiday_date, name, scope, org_unit_code, status, source_system, source_reference,
    approved_by, approved_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_SCHEDULE_SQL = `INSERT INTO attendance_schedule (
    schedule_code, employee_uid, name, status, effective_from, effective_to, work_start, work_end,
    late_after, early_before, work_days_json, overnight_shift, source_system, source_reference,
    approved_by, approved_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// A NULL upper bound means "still open"; `? IS NULL OR ...` keeps an open-ended row matchable.
const EFFECTIVE_ON_DATE = `(? IS NULL OR (effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)))`;

function toIsoDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toIsoTimestamp(value) {
  return value == null ? null : new Date(value).toISOString();
}

function toFlag(value) {
  return value ? 1 : 0;
}

function parseWorkDays(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** `date == null` means "do not filter on dates", mirroring the domain predicate. */
function resolveDate(date) {
  return date == null ? null : normalizeEffectiveDate(date, 'date');
}

function mapRuleVersion(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  const times = normalizeTimeRow(mapped);
  return {
    ruleVersionCode: mapped.ruleVersionCode,
    name: mapped.name,
    status: mapped.status,
    effectiveFrom: toIsoDate(mapped.effectiveFrom),
    effectiveTo: toIsoDate(mapped.effectiveTo),
    workStart: times.workStart ?? null,
    workEnd: times.workEnd ?? null,
    lateAfter: times.lateAfter ?? null,
    earlyBefore: times.earlyBefore ?? null,
    overnightShift: Boolean(mapped.overnightShift),
    maxShiftSpanMinutes: Number(mapped.maxShiftSpanMinutes),
    ignoreHolidays: Boolean(mapped.ignoreHolidays),
    // The approved rule owns the working week. NULL means "not specified": the engine then falls back to
    // Mon-Fri AND records that it defaulted, instead of pretending the week was approved.
    workDays: parseWorkDays(mapped.workDaysJson),
    // mysql2 parses JSON columns into arrays/objects; the fixture stores strings. parsePolicyTokens
    // accepts both, so the raw value is passed through untouched.
    leaveTypesJson: mapped.leaveTypesJson ?? null,
    leaveAliasesJson: mapped.leaveAliasesJson ?? null,
    businessStatusesJson: mapped.businessStatusesJson ?? null,
    sourceOfTruth: mapped.sourceOfTruth ?? null,
    approvedBy: mapped.approvedBy ?? null,
    approvedAt: toIsoTimestamp(mapped.approvedAt),
    notes: mapped.notes ?? null,
    createdAt: toIsoTimestamp(mapped.createdAt),
    updatedAt: toIsoTimestamp(mapped.updatedAt),
  };
}

function mapHoliday(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    id: mapped.id,
    holidayDate: toIsoDate(mapped.holidayDate),
    name: mapped.name,
    scope: mapped.scope,
    orgUnitCode: mapped.orgUnitCode ?? null,
    status: mapped.status,
    sourceSystem: mapped.sourceSystem,
    sourceReference: mapped.sourceReference ?? null,
    approvedBy: mapped.approvedBy ?? null,
    approvedAt: toIsoTimestamp(mapped.approvedAt),
    createdAt: toIsoTimestamp(mapped.createdAt),
    updatedAt: toIsoTimestamp(mapped.updatedAt),
  };
}

function mapSchedule(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  const times = normalizeTimeRow(mapped);
  return {
    scheduleCode: mapped.scheduleCode,
    employeeUid: mapped.employeeUid,
    name: mapped.name,
    status: mapped.status,
    effectiveFrom: toIsoDate(mapped.effectiveFrom),
    effectiveTo: toIsoDate(mapped.effectiveTo),
    workStart: times.workStart ?? null,
    workEnd: times.workEnd ?? null,
    lateAfter: times.lateAfter ?? null,
    earlyBefore: times.earlyBefore ?? null,
    workDays: parseWorkDays(mapped.workDaysJson),
    overnightShift: Boolean(mapped.overnightShift),
    sourceSystem: mapped.sourceSystem,
    sourceReference: mapped.sourceReference ?? null,
    approvedBy: mapped.approvedBy ?? null,
    approvedAt: toIsoTimestamp(mapped.approvedAt),
    createdAt: toIsoTimestamp(mapped.createdAt),
    updatedAt: toIsoTimestamp(mapped.updatedAt),
  };
}

async function selectRuleVersionByCode(pool, code) {
  const [rows] = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM attendance_rule_version WHERE rule_version_code = ? LIMIT 1`,
    [code],
  );
  return mapRuleVersion(rows[0]);
}

/** Every approved rule effective on the date, newest effective_from first (ambiguity stays visible). */
async function selectEffectiveRuleVersions(pool, date) {
  const onDate = resolveDate(date);
  const [rows] = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM attendance_rule_version
     WHERE status = 'approved' AND ${EFFECTIVE_ON_DATE}
     ORDER BY effective_from DESC, rule_version_code DESC`,
    [onDate, onDate, onDate],
  );
  return rows.map((row) => mapRuleVersion(row));
}

function createAttendanceRuleMariaDbRepository(pool) {
  return {
    async insertRuleVersion(input) {
      const rule = normalizeRuleVersionInput(input);
      const now = new Date();
      try {
        await pool.query(INSERT_RULE_SQL, [
          rule.ruleVersionCode, rule.name, rule.status, rule.effectiveFrom, rule.effectiveTo,
          rule.workStart, rule.workEnd, rule.lateAfter, rule.earlyBefore,
          toFlag(rule.overnightShift), rule.maxShiftSpanMinutes, toFlag(rule.ignoreHolidays),
          rule.workDays == null ? null : JSON.stringify(rule.workDays),
          rule.leaveTypesJson, rule.leaveAliasesJson, rule.businessStatusesJson, rule.sourceOfTruth,
          rule.approvedBy, rule.approvedAt, rule.notes, now, now,
        ]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          throw new HttpError(409, 'RULE_DUPLICATE_CODE', 'A rule version with that code already exists');
        }
        throw error;
      }
      return selectRuleVersionByCode(pool, rule.ruleVersionCode);
    },

    async findRuleVersionByCode(code) {
      return selectRuleVersionByCode(pool, code);
    },

    async findEffectiveRuleVersions(date) {
      return selectEffectiveRuleVersions(pool, date);
    },

    /** Deterministic pick: the approved rule with the latest effective_from. */
    async findEffectiveRuleVersion(date) {
      const versions = await selectEffectiveRuleVersions(pool, date);
      return versions.length > 0 ? versions[0] : null;
    },

    /** Diagnostics only: lets the engine say "a rule exists but it is not approved". */
    async findEffectiveRuleVersionAnyStatus(date) {
      const onDate = resolveDate(date);
      const [rows] = await pool.query(
        `SELECT ${RULE_COLUMNS} FROM attendance_rule_version
         WHERE ${EFFECTIVE_ON_DATE}
         ORDER BY (status = 'approved') DESC, effective_from DESC, rule_version_code DESC
         LIMIT 1`,
        [onDate, onDate, onDate],
      );
      return mapRuleVersion(rows[0]);
    },

    async listRuleVersions({ status = null } = {}) {
      if (status != null && !RULE_STATUS.includes(status)) {
        throw new HttpError(400, 'RULE_INVALID_STATUS', `status must be one of: ${RULE_STATUS.join(', ')}`);
      }
      const [rows] = await pool.query(
        `SELECT ${RULE_COLUMNS} FROM attendance_rule_version
         WHERE (? IS NULL OR status = ?)
         ORDER BY effective_from DESC, rule_version_code DESC`,
        [status, status],
      );
      return rows.map((row) => mapRuleVersion(row));
    },

    async insertHoliday(input) {
      const holiday = normalizeHolidayInput(input);
      const now = new Date();
      let insertId = null;
      try {
        const [result] = await pool.query(INSERT_HOLIDAY_SQL, [
          holiday.holidayDate, holiday.name, holiday.scope, holiday.orgUnitCode, holiday.status,
          holiday.sourceSystem, holiday.sourceReference, holiday.approvedBy, holiday.approvedAt, now, now,
        ]);
        insertId = result.insertId;
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          throw new HttpError(409, 'HOLIDAY_DUPLICATE', 'A holiday with that date and scope already exists');
        }
        throw error;
      }
      const [rows] = await pool.query(
        `SELECT ${HOLIDAY_COLUMNS} FROM attendance_holiday WHERE id = ? LIMIT 1`,
        [insertId],
      );
      return mapHoliday(rows[0]);
    },

    /**
     * Approved holidays inside the inclusive range: every national/university row plus the department rows
     * of the requested org unit. `org_unit_code = NULL` never matches, so another unit's holiday is excluded.
     */
    async listApprovedHolidays({ from = null, to = null, orgUnitCode = null } = {}) {
      const fromDate = normalizeEffectiveDate(from, 'from');
      const toDate = normalizeEffectiveDate(to, 'to');
      const unit = orgUnitCode == null ? null : String(orgUnitCode);
      const [rows] = await pool.query(
        `SELECT ${HOLIDAY_COLUMNS} FROM attendance_holiday
         WHERE status = 'approved'
           AND (? IS NULL OR holiday_date >= ?)
           AND (? IS NULL OR holiday_date <= ?)
           AND (scope IN ('national', 'university') OR (scope = 'department' AND org_unit_code = ?))
         ORDER BY holiday_date ASC, id ASC`,
        [fromDate, fromDate, toDate, toDate, unit],
      );
      return rows.map((row) => mapHoliday(row));
    },

    async findHolidayOn(date, { orgUnitCode = null } = {}) {
      const onDate = normalizeEffectiveDate(date, 'date');
      const unit = orgUnitCode == null ? null : String(orgUnitCode);
      const [rows] = await pool.query(
        `SELECT ${HOLIDAY_COLUMNS} FROM attendance_holiday
         WHERE status = 'approved' AND holiday_date = ?
           AND (scope IN ('national', 'university') OR (scope = 'department' AND org_unit_code = ?))
         ORDER BY FIELD(scope, 'national', 'university', 'department') ASC, id ASC
         LIMIT 1`,
        [onDate, unit],
      );
      return mapHoliday(rows[0]);
    },

    async insertSchedule(input) {
      const schedule = normalizeScheduleInput(input);
      const now = new Date();
      try {
        await pool.query(INSERT_SCHEDULE_SQL, [
          schedule.scheduleCode, schedule.employeeUid, schedule.name, schedule.status,
          schedule.effectiveFrom, schedule.effectiveTo, schedule.workStart, schedule.workEnd,
          schedule.lateAfter, schedule.earlyBefore, JSON.stringify(schedule.workDays),
          toFlag(schedule.overnightShift), schedule.sourceSystem, schedule.sourceReference,
          schedule.approvedBy, schedule.approvedAt, now, now,
        ]);
      } catch (error) {
        // PK or uk_attendance_schedule_employee_from: both mean the same insert is already there.
        if (error.code === 'ER_DUP_ENTRY') {
          throw new HttpError(409, 'SCHEDULE_DUPLICATE', 'A schedule with that code or employee/effective_from already exists');
        }
        // fk_attendance_schedule_employee. Coded so the fixture twin and this repo agree.
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
          throw new HttpError(404, 'SCHEDULE_UNKNOWN_EMPLOYEE', 'Employee was not found');
        }
        throw error;
      }
      const [rows] = await pool.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM attendance_schedule WHERE schedule_code = ? LIMIT 1`,
        [schedule.scheduleCode],
      );
      return mapSchedule(rows[0]);
    },

    async findEffectiveSchedule(employeeUid, date) {
      const onDate = resolveDate(date);
      const [rows] = await pool.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM attendance_schedule
         WHERE employee_uid = ? AND status = 'approved' AND ${EFFECTIVE_ON_DATE}
         ORDER BY effective_from DESC, schedule_code DESC
         LIMIT 1`,
        [employeeUid, onDate, onDate, onDate],
      );
      return mapSchedule(rows[0]);
    },

    /** Diagnostics only: a pending or rejected schedule is visible here but never used for a calculation. */
    async findEffectiveScheduleAnyStatus(employeeUid, date) {
      const onDate = resolveDate(date);
      const [rows] = await pool.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM attendance_schedule
         WHERE employee_uid = ? AND ${EFFECTIVE_ON_DATE}
         ORDER BY (status = 'approved') DESC, effective_from DESC, schedule_code DESC
         LIMIT 1`,
        [employeeUid, onDate, onDate, onDate],
      );
      return mapSchedule(rows[0]);
    },
  };
}

module.exports = { createAttendanceRuleMariaDbRepository };
