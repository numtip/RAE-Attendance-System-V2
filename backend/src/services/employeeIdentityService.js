/**
 * Maps external identifiers to employees.employee_uid via employee_identifier and employees.employee_id.
 * national_id: MJU SSO / identity resolution only (never attendance key).
 * facescan_id: attendance-source identity (HIP USERID).
 * SSO provider subjects remain in employee_identity_links only.
 */

const {
  isResolvableIdentifierType,
  isStoredIdentifierType,
  normalizeIdentifierValue,
  maskIdentifierForLog,
  notFoundMessage,
} = require('../domain/employeeIdentifier');
const { HttpError } = require('../utils/httpError');

function createEmployeeIdentityService({ repositories }) {
  const employeeIdentifiers = repositories.employeeIdentifiers;
  const employees = repositories.employees;

  async function resolveToEmployee(idType, idValue) {
    const normalized = normalizeIdentifierValue(idType, idValue);
    if (!normalized) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'identifier value is required');
    }

    if (idType === 'employee_id') {
      const byColumn = employees.findByEmployeeId
        ? await employees.findByEmployeeId(normalized)
        : null;
      if (byColumn) {
        return employees.findByUid(byColumn.employeeUid);
      }
    }

    const link = await employeeIdentifiers.findActiveByTypeAndValue(idType, normalized);
    if (!link) {
      throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', notFoundMessage(idType));
    }
    const employee = await employees.findByUid(link.employeeUid);
    if (!employee) {
      throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', notFoundMessage(idType));
    }
    return employee;
  }

  return {
    async resolveByEmail(email) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!normalized) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'email is required');
      }
      const employee = await employees.findByEmail(normalized);
      if (!employee) {
        throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found for email');
      }
      return employee;
    },

    async resolve(identifierType, identifierValue) {
      const idType = String(identifierType || '').trim();
      if (!isResolvableIdentifierType(idType)) {
        throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported identifier type: ${idType}`);
      }
      if (identifierValue == null || String(identifierValue).trim() === '') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'identifier value is required');
      }
      return resolveToEmployee(idType, identifierValue);
    },

    async resolveUid(identifierType, identifierValue) {
      const employee = await this.resolve(identifierType, identifierValue);
      return employee.employeeUid;
    },

    /** @deprecated Prefer resolve() / resolveUid(). */
    async resolveExternalId(idType, idValue) {
      return this.resolve(idType, idValue);
    },

    async linkIdentifier(input) {
      const idType = String(input.idType || input.identifierType || '').trim();
      const idValue = input.idValue ?? input.identifierValue;
      const employeeUid = input.employeeUid;

      if (!employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'employeeUid is required');
      }

      if (!isStoredIdentifierType(idType)) {
        throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported identifier type for link: ${idType}`);
      }

      const normalized = normalizeIdentifierValue(idType, idValue);
      if (idType === 'national_id' && normalized.replace(/\D/g, '').length !== 13) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
      }

      const employee = await employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      }

      try {
        return await employeeIdentifiers.insert({
          employeeUid,
          idType,
          idValue: normalized,
          sourceSystem: input.sourceSystem ?? null,
          isPrimary: Boolean(input.isPrimary),
          verifiedAt: input.verifiedAt ?? null,
        });
      } catch (error) {
        if (error.code === 'DUPLICATE_IDENTIFIER') {
          throw new HttpError(409, 'DUPLICATE_IDENTIFIER', 'Identifier already linked to another employee');
        }
        if (error.code === 'UNKNOWN_EMPLOYEE') {
          throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
        }
        throw error;
      }
    },

    async unlinkIdentifier({ id, employeeUid }) {
      if (!id || !employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'id and employeeUid are required');
      }
      const removed = await employeeIdentifiers.deactivate(id, employeeUid);
      if (!removed) {
        throw new HttpError(404, 'IDENTIFIER_NOT_FOUND', 'Identifier not found');
      }
      return { id, employeeUid, status: 'inactive' };
    },

    async listIdentifiers(employeeUid) {
      if (!employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'employeeUid is required');
      }
      const rows = await employeeIdentifiers.listByEmployeeUid(employeeUid);
      return rows.map((row) => ({
        id: row.id,
        employeeUid: row.employeeUid,
        idType: row.idType,
        idValue: row.idType === 'national_id' ? undefined : row.idValue,
        idValueMasked: maskIdentifierForLog(row.idType, row.idValue),
        sourceSystem: row.sourceSystem,
        isPrimary: row.isPrimary,
        status: row.status,
        verifiedAt: row.verifiedAt,
      }));
    },
  };
}

module.exports = { createEmployeeIdentityService };
