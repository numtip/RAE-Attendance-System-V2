const { HttpError } = require('../utils/httpError');
const { assertCanReadEmployee } = require('./access');

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
}

function assertMonth(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'year is invalid');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'month is invalid');
  }
}

function createAttendanceService({ repositories }) {
  return {
    async daily(auth, date) {
      assertDate(date);
      if (auth.role !== 'admin' && auth.role !== 'manager') {
        throw new HttpError(403, 'FORBIDDEN', 'Daily attendance for all employees requires a manager or admin role');
      }
      return repositories.attendance.findDaily(date);
    },
    async monthly(auth, employeeUid, year, month) {
      assertMonth(year, month);
      assertCanReadEmployee(auth, employeeUid);
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      const summary = await repositories.attendance.findMonthly(employeeUid, year, month);
      if (!summary) {
        throw new HttpError(404, 'NOT_FOUND', 'Monthly summary was not found');
      }
      return summary;
    },
    async forEmployee(auth, employeeUid) {
      assertCanReadEmployee(auth, employeeUid);
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return repositories.attendance.findForEmployee(employeeUid);
    },
  };
}

module.exports = { createAttendanceService };
