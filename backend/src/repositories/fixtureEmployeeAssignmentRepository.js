const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const {
  ASSIGNMENT_CONFLICT_CODES,
  normalizeEffectiveDate,
  windowsOverlapWithinEmployee,
  windowsOverlapForCode,
  isEffectiveOn,
} = require('../domain/employeeAssignment');

const DUPLICATE_CODE = 'ASSIGNMENT_DUPLICATE_EFFECTIVE_FROM';

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWindow(input) {
  const effectiveFrom = normalizeEffectiveDate(input.effectiveFrom, 'effective_from');
  if (effectiveFrom == null) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'effective_from must be an ISO date (YYYY-MM-DD)');
  }
  const effectiveTo = normalizeEffectiveDate(input.effectiveTo, 'effective_to');
  if (effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
  }
  return { effectiveFrom, effectiveTo };
}

/**
 * In-memory twin of the MariaDB employee_assignment repository. Same method names, return shapes and
 * error codes, so services and tests can run without a database.
 */
function createFixtureEmployeeAssignmentRepository(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));

  return {
    async insert(input) {
      const window = normalizeWindow(input);

      // Duplicate start dates are reported distinctly from a wider overlap (uk_employee_assignment_employee_from).
      const duplicate = rows.find(
        (row) => row.employeeUid === input.employeeUid && row.effectiveFrom === window.effectiveFrom,
      );
      if (duplicate) {
        throw new HttpError(409, DUPLICATE_CODE, 'An assignment with that effective_from already exists for this employee');
      }

      const sameEmployee = rows.find(
        (row) => row.employeeUid === input.employeeUid && windowsOverlapWithinEmployee(row, window),
      );
      if (sameEmployee) {
        throw new HttpError(409, ASSIGNMENT_CONFLICT_CODES.OVERLAP, 'The effective window overlaps an existing assignment for this employee');
      }

      const codeOwner = rows.find(
        (row) => row.employeeUid !== input.employeeUid
          && row.employeeCode === input.employeeCode
          && windowsOverlapForCode(row, window),
      );
      if (codeOwner) {
        throw new HttpError(409, ASSIGNMENT_CONFLICT_CODES.CODE_CONFLICT, 'The employee_code is held by another employee over an overlapping window');
      }

      const now = new Date().toISOString();
      const record = {
        assignmentUid: input.assignmentUid || randomUUID(),
        employeeUid: input.employeeUid,
        employeeCode: input.employeeCode,
        department: input.department,
        position: input.position ?? null,
        employeeType: input.employeeType,
        effectiveFrom: window.effectiveFrom,
        effectiveTo: window.effectiveTo,
        sourceSystem: input.sourceSystem,
        sourceReference: input.sourceReference ?? null,
        recordedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(record);
      return { ...record };
    },

    async listByEmployeeUid(employeeUid, { onDate = null, includeFuture = true } = {}) {
      const date = normalizeEffectiveDate(onDate, 'onDate');
      const today = todayDateOnly();
      return rows
        .filter((row) => row.employeeUid === employeeUid)
        .filter((row) => (date == null ? true : isEffectiveOn(row, date)))
        .filter((row) => includeFuture || row.effectiveFrom <= today)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
        .map((row) => ({ ...row }));
    },

    async findEffectiveOn(employeeUid, date) {
      const onDate = normalizeEffectiveDate(date, 'date');
      if (onDate == null) {
        throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'date must be an ISO date (YYYY-MM-DD)');
      }
      const hits = rows
        .filter((row) => row.employeeUid === employeeUid && isEffectiveOn(row, onDate))
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
      return hits.length > 0 ? { ...hits[0] } : null;
    },

    async closeAssignment(assignmentUid, employeeUid, effectiveTo) {
      const date = normalizeEffectiveDate(effectiveTo, 'effective_to');
      if (date == null) {
        throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'effective_to must be an ISO date (YYYY-MM-DD)');
      }
      const row = rows.find((item) => item.assignmentUid === assignmentUid && item.employeeUid === employeeUid);
      if (!row) return null;
      if (date < row.effectiveFrom) {
        throw new HttpError(400, 'ASSIGNMENT_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
      }
      row.effectiveTo = date;
      row.updatedAt = new Date().toISOString();
      return { ...row };
    },

    /** Test hook: a copy of every stored row. */
    all() {
      return rows.map((row) => ({ ...row }));
    },
  };
}

module.exports = { createFixtureEmployeeAssignmentRepository };
