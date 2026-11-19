const { HttpError } = require('../utils/httpError');
const { createAttendanceCoreClient } = require('./attendanceCoreClient');
const { createEmployeeIdentityService } = require('./employeeIdentityService');
const { resolveScope } = require('./authorizationService');

const ALLOWED_SOURCES = new Set(['CSV_IMPORT', 'FACESCAN_DB', 'API', 'MANUAL_CORRECTION']);

// One month of days per evaluate-period call: the core is a rule evaluator, not a bulk exporter.
const MAX_PERIOD_DAYS = 31;

/**
 * Evaluation is an attendance read, so it uses the same authorization as every other read: the
 * canonical role plus a data scope from grants (an organization-wide executive grant, or a manager
 * with org-unit grants). A raw role string ('admin'/'manager') is not an authorization — it let any
 * holder evaluate and resolve any employee, and the executive role could not use it at all.
 * Fails closed when repositories are missing: without them there is no scope to check.
 */
async function resolveComputeScope(auth, repositories) {
  if (!repositories) {
    throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'Employee repositories are not configured');
  }
  const scope = await resolveScope(auth, repositories, 'data');
  if (!(scope.all || scope.broad)) {
    throw new HttpError(403, 'FORBIDDEN', 'Attendance evaluation requires a data scope (executive or manager grant)');
  }
  return scope;
}

function assertEmployeeInScope(scope, employeeUid) {
  if (scope.all || scope.uids.has(employeeUid)) return;
  throw new HttpError(403, 'FORBIDDEN', 'This employee is outside your scope');
}

function normalizeEvaluateDayBody(body) {
  const employeeId = String(body.employee_id || body.employeeId || '').trim();
  const date = String(body.date || '').trim();
  if (!employeeId || !date) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'employee_id and date are required');
  }
  const source = String(body.source || 'API').trim().toUpperCase();
  if (!ALLOWED_SOURCES.has(source)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported attendance source: ${source}`);
  }
  const remarks = Array.isArray(body.remarks) ? body.remarks : body.remarks ? [String(body.remarks)] : [];
  return {
    employee_id: employeeId,
    date,
    check_in: body.check_in || body.checkIn || '',
    check_out: body.check_out || body.checkOut || '',
    day_status: body.day_status || body.dayStatus || 'WORKDAY',
    remarks,
    source,
    employee_name: body.employee_name || body.employeeName || '',
    department: body.department || '',
  };
}

async function resolveEmployeeUidFromBusinessId(repositories, businessEmployeeId, nationalIdProtector = null) {
  if (!repositories?.employees) {
    throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'Employee repositories are not configured');
  }
  // The container's protector must reach this service. Without it the identity service falls back to `null`
  // and every national-ID operation answers 503 even with a valid key configured (verified: the container
  // built a protector that no call site passed on).
  const identity = createEmployeeIdentityService({ repositories, nationalIdProtector });
  return identity.resolveUid('employee_id', businessEmployeeId);
}

function buildCoreEvaluateDayPayload(boundaryPayload, employeeUid) {
  return {
    ...boundaryPayload,
    employee_uid: employeeUid,
    employeeUid,
  };
}

function createAttendanceComputeService(options = {}) {
  const config = options.config || options.container?.config || {};
  const repositories = options.repositories || options.container?.repositories;
  const nationalIdProtector = options.nationalIdProtector || options.container?.nationalIdProtector || null;
  const coreClient = options.coreClient || createAttendanceCoreClient({
    baseUrl: options.baseUrl || config.attendanceCore?.url,
    timeoutMs: options.timeoutMs || config.attendanceCore?.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  return {
    async evaluateDay(auth, body) {
      const scope = await resolveComputeScope(auth, repositories);
      const boundaryPayload = normalizeEvaluateDayBody(body);
      const employeeUid = await resolveEmployeeUidFromBusinessId(
        repositories,
        boundaryPayload.employee_id,
        nationalIdProtector,
      );
      assertEmployeeInScope(scope, employeeUid);
      const corePayload = buildCoreEvaluateDayPayload(boundaryPayload, employeeUid);
      const result = await coreClient.evaluateDay(corePayload);
      return {
        ...result,
        employeeUid,
        source: boundaryPayload.source,
        explainedBy: 'attendance-core',
      };
    },

    async evaluatePeriod(auth, body) {
      const scope = await resolveComputeScope(auth, repositories);
      const days = Array.isArray(body.days) ? body.days : [];
      if (!days.length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'days must be a non-empty array');
      }
      if (days.length > MAX_PERIOD_DAYS) {
        throw new HttpError(400, 'VALIDATION_ERROR', `days must not exceed ${MAX_PERIOD_DAYS} entries`);
      }
      const normalizedDays = days.map((day) => normalizeEvaluateDayBody(day));
      // Resolve and check every day before the core sees any of them: one out-of-scope day refuses the call.
      const coreDays = await Promise.all(normalizedDays.map(async (day) => {
        const employeeUid = await resolveEmployeeUidFromBusinessId(repositories, day.employee_id, nationalIdProtector);
        assertEmployeeInScope(scope, employeeUid);
        return buildCoreEvaluateDayPayload(day, employeeUid);
      }));
      return coreClient.evaluatePeriod({
        month: body.month || '',
        days: coreDays,
      });
    },

    async explainResult(auth, body) {
      const evaluated = await this.evaluateDay(auth, body);
      return {
        employee_id: evaluated.employee_id,
        employeeUid: evaluated.employeeUid,
        date: evaluated.date,
        attendance_status: evaluated.attendance_status,
        issues: evaluated.issues || [],
        leave_type: evaluated.leave_type,
        policySource: 'attendance-core',
      };
    },
  };
}

module.exports = {
  MAX_PERIOD_DAYS,
  createAttendanceComputeService,
  normalizeEvaluateDayBody,
  resolveEmployeeUidFromBusinessId,
  buildCoreEvaluateDayPayload,
};
