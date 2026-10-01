const { HttpError } = require('../utils/httpError');
const { assertCanReadEmployee } = require('./access');

function createLeaveService({ repositories }) {
  return {
    async list(auth, employeeUid) {
      const target = employeeUid || auth.employeeUid;
      assertCanReadEmployee(auth, target);
      return repositories.leave.list(target);
    },
    async history(auth, employeeUid) {
      assertCanReadEmployee(auth, employeeUid);
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return repositories.leave.history(employeeUid);
    },
    async balance(auth, employeeUid, year) {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'year is invalid');
      }
      assertCanReadEmployee(auth, employeeUid);
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return repositories.leave.balance(employeeUid, year);
    },
  };
}

module.exports = { createLeaveService };
