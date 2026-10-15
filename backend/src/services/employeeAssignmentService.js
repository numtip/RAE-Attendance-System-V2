const { HttpError } = require('../utils/httpError');
const { canonicalRole, ROLES } = require('./authorizationService');
const { assertCanReadEmployee } = require('./access');
const { normalizeAssignmentInput } = require('../domain/employeeAssignment');

function assertAdmin(auth) {
  if (canonicalRole(auth && auth.role) !== ROLES.ADMIN) {
    throw new HttpError(403, 'FORBIDDEN', 'Administrator role is required');
  }
}

function createEmployeeAssignmentService({ repositories }) {
  return {
    async listForEmployee(auth, employeeUid, { onDate = null } = {}) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'directory');
      return repositories.employeeAssignments.listByEmployeeUid(employeeUid, { onDate });
    },

    async effectiveOn(auth, employeeUid, date) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'directory');
      const record = await repositories.employeeAssignments.findEffectiveOn(employeeUid, date);
      if (!record) {
        throw new HttpError(404, 'ASSIGNMENT_NOT_EFFECTIVE', 'No assignment was effective on that date');
      }
      return record;
    },

    async create(auth, input) {
      assertAdmin(auth);
      const normalized = normalizeAssignmentInput(input);
      // Check the employee up front so both repository twins answer 404 instead of one succeeding silently
      // and the other surfacing a raw foreign-key error.
      const employee = await repositories.employees.findByUid(normalized.employeeUid);
      if (!employee) {
        throw new HttpError(404, 'ASSIGNMENT_UNKNOWN_EMPLOYEE', 'Employee was not found');
      }
      return repositories.employeeAssignments.insert({ ...normalized, actor: auth.employeeUid });
    },

    async close(auth, assignmentUid, { employeeUid, effectiveTo } = {}) {
      assertAdmin(auth);
      return repositories.employeeAssignments.closeAssignment(assignmentUid, employeeUid, effectiveTo);
    },
  };
}

module.exports = { createEmployeeAssignmentService };
