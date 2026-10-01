const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { assertCanReadEmployee } = require('./access');

function createEmployeeService({ repositories }) {
  return {
    async list(auth) {
      const scope = await resolveScope(auth, repositories, 'directory');
      const rows = await repositories.employees.list();
      if (scope.all) return rows;
      return rows.filter((row) => scope.uids.has(row.employeeUid));
    },
    async getByUid(auth, employeeUid, queryEmployeeId) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'directory');
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      if (queryEmployeeId && queryEmployeeId !== employee.employeeId) {
        throw new HttpError(403, 'FORBIDDEN', 'employee_id cannot widen scope');
      }
      return employee;
    },
  };
}

module.exports = { createEmployeeService };
