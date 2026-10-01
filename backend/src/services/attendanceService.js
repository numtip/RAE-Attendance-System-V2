const { HttpError } = require('../utils/httpError');
const { assertCanReadEmployee } = require('./access');
const { resolveScope } = require('./authorizationService');

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
      const scope = await resolveScope(auth, repositories, 'data');
      if (!scope.broad && !scope.all) {
        throw new HttpError(403, 'FORBIDDEN', 'Daily attendance for other employees is outside your scope');
      }
      const rows = await repositories.attendance.findDaily(date);
      if (scope.all) return rows;
      return rows.filter((row) => scope.uids.has(row.employeeUid));
    },
    async monthly(auth, employeeUid, year, month) {
      assertMonth(year, month);
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
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
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return repositories.attendance.findForEmployee(employeeUid);
    },
  };
}

module.exports = { createAttendanceService };
