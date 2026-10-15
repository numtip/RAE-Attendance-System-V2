const { HttpError } = require('../utils/httpError');

const EMPLOYEE_TYPES = Object.freeze(['university', 'department', 'contract']);

const ASSIGNMENT_CONFLICT_CODES = Object.freeze({
  OVERLAP: 'ASSIGNMENT_WINDOW_OVERLAP',
  CODE_CONFLICT: 'ASSIGNMENT_CODE_CONFLICT',
});

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function invalidDate(fieldName) {
  // The offending value is never included: these messages may be surfaced or logged.
  return new HttpError(400, 'ASSIGNMENT_INVALID_DATE', `${fieldName} must be an ISO date (YYYY-MM-DD)`);
}

function isRealCalendarDate(text) {
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

/** Normalize a date-only value to 'YYYY-MM-DD', or null for empty input. */
function normalizeEffectiveDate(value, fieldName = 'date') {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidDate(fieldName);
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (ISO_DATE_PATTERN.test(text) && isRealCalendarDate(text)) return text;
  }
  throw invalidDate(fieldName);
}

/** Closed-interval overlap with null effectiveTo meaning "+infinity". */
function intervalsOverlap(a, b) {
  if (a.effectiveTo != null && a.effectiveTo < b.effectiveFrom) return false;
  if (b.effectiveTo != null && b.effectiveTo < a.effectiveFrom) return false;
  return true;
}

/** Overlap rule for two windows of the SAME employee. */
function windowsOverlapWithinEmployee(a, b) {
  return intervalsOverlap(a, b);
}

/** Overlap rule for two windows holding the SAME employee_code. Kept separate so the rules can diverge. */
function windowsOverlapForCode(a, b) {
  return intervalsOverlap(a, b);
}

/** True when a date-only string falls inside the record's window (both bounds inclusive). */
function isEffectiveOn(record, date) {
  if (record.effectiveFrom != null && record.effectiveFrom > date) return false;
  if (record.effectiveTo != null && record.effectiveTo < date) return false;
  return true;
}

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAssignmentInput(input) {
  const source = input || {};

  const employeeUid = trimmedText(source.employeeUid);
  if (!employeeUid) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_EMPLOYEE', 'employee_uid is required');
  }

  const employeeCode = trimmedText(source.employeeCode);
  if (!employeeCode || employeeCode.length > 50) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_CODE', 'employee_code is required and must be at most 50 characters');
  }

  const department = trimmedText(source.department);
  if (!department || department.length > 100) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_DEPARTMENT', 'department is required and must be at most 100 characters');
  }

  const position = trimmedText(source.position);
  if (position.length > 100) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_POSITION', 'position must be at most 100 characters');
  }

  const employeeType = trimmedText(source.employeeType);
  if (!EMPLOYEE_TYPES.includes(employeeType)) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_EMPLOYEE_TYPE', `employee_type must be one of: ${EMPLOYEE_TYPES.join(', ')}`);
  }

  const effectiveFrom = normalizeEffectiveDate(source.effectiveFrom, 'effective_from');
  if (effectiveFrom == null) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'effective_from must be an ISO date (YYYY-MM-DD)');
  }
  const effectiveTo = normalizeEffectiveDate(source.effectiveTo, 'effective_to');
  if (effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
  }

  const sourceSystem = trimmedText(source.sourceSystem);
  if (!sourceSystem || sourceSystem.length > 64) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_SOURCE', 'source_system is required and must be at most 64 characters');
  }
  const sourceReference = trimmedText(source.sourceReference);
  if (sourceReference.length > 255) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_SOURCE', 'source_reference must be at most 255 characters');
  }

  return {
    employeeUid,
    employeeCode,
    department,
    position: position || null,
    employeeType,
    effectiveFrom,
    effectiveTo,
    sourceSystem,
    sourceReference: sourceReference || null,
  };
}

module.exports = {
  EMPLOYEE_TYPES,
  ASSIGNMENT_CONFLICT_CODES,
  normalizeEffectiveDate,
  windowsOverlapWithinEmployee,
  windowsOverlapForCode,
  isEffectiveOn,
  normalizeAssignmentInput,
};
