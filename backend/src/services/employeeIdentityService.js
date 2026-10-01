/**
 * Identity resolution contract — never join attendance rows by display name when a stable ID exists.
 * Maps external identifiers to employees.employee_uid via employee_identifier (future) and employees.email.
 */

const { HttpError } = require('../utils/httpError');

const ID_TYPES = ['employee_id', 'personnel_id', 'facescan_id', 'sso_subject', 'national_id'];

function createEmployeeIdentityService({ repositories }) {
  return {
    async resolveByEmail(email) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!normalized) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'email is required');
      }
      const employee = await repositories.employees.findByEmail(normalized);
      if (!employee) {
        throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found for email');
      }
      return employee;
    },

    /**
     * Placeholder for employee_identifier repository wiring.
     * Callers must pass id_type from ID_TYPES and must not log national_id values.
     */
    async resolveExternalId(idType, idValue) {
      if (!ID_TYPES.includes(idType)) {
        throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported id_type: ${idType}`);
      }
      if (!idValue) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'id_value is required');
      }
      if (idType === 'national_id') {
        throw new HttpError(501, 'NOT_IMPLEMENTED', 'national_id lookup requires employee_identifier repository');
      }
      throw new HttpError(501, 'NOT_IMPLEMENTED', 'employee_identifier repository is not wired yet');
    },
  };
}

module.exports = { createEmployeeIdentityService, ID_TYPES };
