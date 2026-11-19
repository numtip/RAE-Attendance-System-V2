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

/**
 * Attach the Thai full name and employee ID to rows that are ALREADY scope-filtered. Resolution is
 * limited to the uids present in those rows, so an out-of-scope employee is never looked up or
 * exposed. A uid with no employee record keeps null names (the UI says so, it does not guess).
 */
async function withIdentity(repositories, rows) {
  if (rows.length === 0) return rows;
  const wanted = new Set(rows.map((row) => row.employeeUid));
  const byUid = new Map(
    (await repositories.employees.list())
      .filter((employee) => wanted.has(employee.employeeUid))
      .map((employee) => [employee.employeeUid, employee]),
  );
  return rows.map((row) => {
    const employee = byUid.get(row.employeeUid);
    return {
      ...row,
      employeeId: employee ? employee.employeeId : null,
      employeeName: employee ? `${employee.firstNameTh} ${employee.lastNameTh}`.trim() : null,
    };
  });
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
      const visible = scope.all ? rows : rows.filter((row) => scope.uids.has(row.employeeUid));
      return withIdentity(repositories, visible);
    },
    /**
     * The caller's own day. `auth.employeeUid` is the only subject, so there is no argument that
     * could widen the result and no scope resolution to get wrong.
     */
    async meDaily(auth, date) {
      assertDate(date);
      const rows = await repositories.attendance.findDaily(date);
      return withIdentity(repositories, rows.filter((row) => row.employeeUid === auth.employeeUid));
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
