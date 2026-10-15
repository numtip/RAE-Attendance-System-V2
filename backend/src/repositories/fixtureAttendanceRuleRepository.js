/**
 * In-memory twin of the attendance_rule / attendance_holiday / attendance_schedule repositories.
 * Same method names, return shapes and error codes as the MariaDB twin, so services and tests can run
 * without a database and the two implementations cannot disagree silently.
 *
 * The optional `employeeExists` hook mirrors the fk_attendance_schedule_employee foreign key: pass it
 * wherever this fixture stands in for the real repo, otherwise an unknown employee_uid would succeed here
 * and fail with an FK error in MariaDB.
 */
const { HttpError } = require('../utils/httpError');
const {
  RULE_STATUS,
  normalizeRuleVersionInput,
  normalizeScheduleInput,
  normalizeHolidayInput,
  normalizeEffectiveDate,
  isRuleEffectiveOn,
  isScheduleEffectiveOn,
} = require('../domain/attendanceRule');

/** Newest effective_from first; the code is the deterministic tie-break for equal start dates. */
function byEffectiveFromDesc(codeKey) {
  return (a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    const left = a[codeKey] || '';
    const right = b[codeKey] || '';
    if (left === right) return 0;
    return left < right ? 1 : -1;
  };
}

/** Approved rows win over any other status, then newest effective_from first. */
function byApprovalThenEffectiveFromDesc(codeKey) {
  const effectiveFirst = byEffectiveFromDesc(codeKey);
  return (a, b) => {
    const aApproved = a.status === 'approved' ? 1 : 0;
    const bApproved = b.status === 'approved' ? 1 : 0;
    if (aApproved !== bApproved) return bApproved - aApproved;
    return effectiveFirst(a, b);
  };
}

function scopeMatches(holiday, orgUnitCode) {
  if (holiday.scope === 'national' || holiday.scope === 'university') return true;
  return holiday.scope === 'department' && orgUnitCode != null && holiday.orgUnitCode === orgUnitCode;
}

/** Longest scope first: national, then university, then department. */
function byScopePriority(a, b) {
  const order = { national: 1, university: 2, department: 3 };
  return (order[a.scope] || 99) - (order[b.scope] || 99);
}

function createFixtureAttendanceRuleRepository(initial = {}, { employeeExists = null } = {}) {
  const rules = (initial.ruleVersions || []).map((row) => ({ ...row }));
  const holidays = (initial.holidays || []).map((row) => ({ ...row }));
  const schedules = (initial.schedules || []).map((row) => ({ ...row }));
  let nextHolidayId = holidays.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;

  const stamp = () => new Date().toISOString();

  function effectiveRulesOn(date, codeKey) {
    return rules
      .filter((row) => row.status === 'approved' && isRuleEffectiveOn(row, date))
      .sort(byEffectiveFromDesc(codeKey));
  }

  function effectiveSchedulesOn(employeeUid, date, { approvedOnly }) {
    return schedules
      .filter((row) => row.employeeUid === employeeUid && isScheduleEffectiveOn(row, date))
      .filter((row) => !approvedOnly || row.status === 'approved')
      .sort(byApprovalThenEffectiveFromDesc('scheduleCode'));
  }

  return {
    async insertRuleVersion(input) {
      const normalized = normalizeRuleVersionInput(input);
      if (rules.some((row) => row.ruleVersionCode === normalized.ruleVersionCode)) {
        throw new HttpError(409, 'RULE_DUPLICATE_CODE', 'A rule version with that code already exists');
      }
      const now = stamp();
      const record = { ...normalized, createdAt: now, updatedAt: now };
      rules.push(record);
      return { ...record };
    },

    async findRuleVersionByCode(code) {
      const found = rules.find((row) => row.ruleVersionCode === code);
      return found ? { ...found } : null;
    },

    /** Every approved rule effective on the date, newest effective_from first (ambiguity stays visible). */
    async findEffectiveRuleVersions(date) {
      const onDate = date == null ? null : normalizeEffectiveDate(date, 'date');
      return effectiveRulesOn(onDate, 'ruleVersionCode').map((row) => ({ ...row }));
    },

    /** Deterministic pick: the approved rule with the latest effective_from. */
    async findEffectiveRuleVersion(date) {
      const onDate = date == null ? null : normalizeEffectiveDate(date, 'date');
      const hits = effectiveRulesOn(onDate, 'ruleVersionCode');
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    /** Diagnostics only: lets the engine say "a rule exists but it is not approved". */
    async findEffectiveRuleVersionAnyStatus(date) {
      const onDate = date == null ? null : normalizeEffectiveDate(date, 'date');
      const hits = rules
        .filter((row) => isRuleEffectiveOn(row, onDate))
        .sort(byApprovalThenEffectiveFromDesc('ruleVersionCode'));
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    async listRuleVersions({ status = null } = {}) {
      if (status != null && !RULE_STATUS.includes(status)) {
        throw new HttpError(400, 'RULE_INVALID_STATUS', `status must be one of: ${RULE_STATUS.join(', ')}`);
      }
      return rules
        .filter((row) => status == null || row.status === status)
        .sort(byEffectiveFromDesc('ruleVersionCode'))
        .map((row) => ({ ...row }));
    },

    async insertHoliday(input) {
      const normalized = normalizeHolidayInput(input);
      const duplicate = holidays.some((row) => row.holidayDate === normalized.holidayDate
        && row.scope === normalized.scope
        && (row.orgUnitCode || '') === (normalized.orgUnitCode || ''));
      if (duplicate) {
        throw new HttpError(409, 'HOLIDAY_DUPLICATE', 'A holiday with that date and scope already exists');
      }
      const now = stamp();
      const record = { ...normalized, id: nextHolidayId, createdAt: now, updatedAt: now };
      nextHolidayId += 1;
      holidays.push(record);
      return { ...record };
    },

    /**
     * Approved holidays inside the inclusive range: every national/university row plus the department rows
     * of the requested org unit. A department holiday for another unit is never returned.
     */
    async listApprovedHolidays({ from = null, to = null, orgUnitCode = null } = {}) {
      const fromDate = normalizeEffectiveDate(from, 'from');
      const toDate = normalizeEffectiveDate(to, 'to');
      const unit = orgUnitCode == null ? null : String(orgUnitCode);
      return holidays
        .filter((row) => row.status === 'approved')
        .filter((row) => fromDate == null || row.holidayDate >= fromDate)
        .filter((row) => toDate == null || row.holidayDate <= toDate)
        .filter((row) => scopeMatches(row, unit))
        .sort((a, b) => (a.holidayDate < b.holidayDate ? -1 : a.holidayDate > b.holidayDate ? 1 : (a.id || 0) - (b.id || 0)))
        .map((row) => ({ ...row }));
    },

    async findHolidayOn(date, { orgUnitCode = null } = {}) {
      const onDate = normalizeEffectiveDate(date, 'date');
      const unit = orgUnitCode == null ? null : String(orgUnitCode);
      const hits = holidays
        .filter((row) => row.status === 'approved' && row.holidayDate === onDate && scopeMatches(row, unit))
        .sort(byScopePriority);
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    async insertSchedule(input) {
      const normalized = normalizeScheduleInput(input);
      const duplicate = schedules.some((row) => row.scheduleCode === normalized.scheduleCode
        || (row.employeeUid === normalized.employeeUid && row.effectiveFrom === normalized.effectiveFrom));
      if (duplicate) {
        throw new HttpError(409, 'SCHEDULE_DUPLICATE', 'A schedule with that code or employee/effective_from already exists');
      }
      if (employeeExists && !employeeExists(normalized.employeeUid)) {
        throw new HttpError(404, 'SCHEDULE_UNKNOWN_EMPLOYEE', 'Employee was not found');
      }
      const now = stamp();
      const record = { ...normalized, createdAt: now, updatedAt: now };
      schedules.push(record);
      return { ...record };
    },

    async findEffectiveSchedule(employeeUid, date) {
      const onDate = date == null ? null : normalizeEffectiveDate(date, 'date');
      const hits = effectiveSchedulesOn(employeeUid, onDate, { approvedOnly: true });
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    /** Diagnostics only: a pending or rejected schedule is visible here but never used for a calculation. */
    async findEffectiveScheduleAnyStatus(employeeUid, date) {
      const onDate = date == null ? null : normalizeEffectiveDate(date, 'date');
      const hits = effectiveSchedulesOn(employeeUid, onDate, { approvedOnly: false });
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    /** Test hook: a copy of every stored row. */
    all() {
      return {
        ruleVersions: rules.map((row) => ({ ...row })),
        holidays: holidays.map((row) => ({ ...row })),
        schedules: schedules.map((row) => ({ ...row })),
      };
    },
  };
}

module.exports = { createFixtureAttendanceRuleRepository };
