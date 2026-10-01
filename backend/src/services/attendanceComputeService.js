const { HttpError } = require('../utils/httpError');
const { createAttendanceCoreClient } = require('./attendanceCoreClient');

const ALLOWED_SOURCES = new Set(['CSV_IMPORT', 'FACESCAN_DB', 'API', 'MANUAL_CORRECTION']);

function assertCanCompute(auth) {
  if (auth.role === 'admin' || auth.role === 'manager') {
    return;
  }
  throw new HttpError(403, 'FORBIDDEN', 'Attendance evaluation requires a manager or admin role');
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

function createAttendanceComputeService(options = {}) {
  const config = options.config || {};
  const coreClient = options.coreClient || createAttendanceCoreClient({
    baseUrl: options.baseUrl || config.attendanceCore?.url,
    timeoutMs: options.timeoutMs || config.attendanceCore?.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  return {
    async evaluateDay(auth, body) {
      assertCanCompute(auth);
      const payload = normalizeEvaluateDayBody(body);
      const result = await coreClient.evaluateDay(payload);
      return {
        ...result,
        source: payload.source,
        explainedBy: 'attendance-core',
      };
    },

    async evaluatePeriod(auth, body) {
      assertCanCompute(auth);
      const days = Array.isArray(body.days) ? body.days : [];
      if (!days.length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'days must be a non-empty array');
      }
      const normalizedDays = days.map((day) => normalizeEvaluateDayBody(day));
      return coreClient.evaluatePeriod({
        month: body.month || '',
        days: normalizedDays,
      });
    },

    async explainResult(auth, body) {
      assertCanCompute(auth);
      const evaluated = await this.evaluateDay(auth, body);
      return {
        employee_id: evaluated.employee_id,
        date: evaluated.date,
        attendance_status: evaluated.attendance_status,
        issues: evaluated.issues || [],
        leave_type: evaluated.leave_type,
        policySource: 'attendance-core',
      };
    },
  };
}

module.exports = { createAttendanceComputeService, normalizeEvaluateDayBody };
