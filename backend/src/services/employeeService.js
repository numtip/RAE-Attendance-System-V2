const { HttpError } = require('../utils/httpError');

function createEmployeeService({ repositories }) {
  return {
    async list() {
      return repositories.employees.list();
    },
    async getByUid(employeeUid) {
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return employee;
    },
  };
}

module.exports = { createEmployeeService };
