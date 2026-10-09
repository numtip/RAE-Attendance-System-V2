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
const { MJU_PERSONNEL_SOURCE, NAMESPACE_PAIR, deriveIdentityKind, ssoPolicyForKind } = require('../domain/identityKind');

/** Maps contract/repository protection errors to HTTP errors without echoing any identifier. */
function mapProtectionError(error) {
  const code = String(error?.code || '');
  if (code.startsWith('NOT_CONFIGURED')) {
    return new HttpError(503, 'NATIONAL_ID_PROTECTION_UNAVAILABLE', 'National ID protection is not configured');
  }
  if (code === 'NATIONAL_ID_WRITES_FROZEN') {
    return new HttpError(503, 'NATIONAL_ID_WRITES_FROZEN', 'National ID writes are frozen during key rotation');
  }
  if (code === 'INVALID_IDENTIFIER') {
    return new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
  }
  if (code === 'WRITE_LOCK_TIMEOUT') {
    return new HttpError(503, 'NATIONAL_ID_WRITE_BUSY', 'National ID write is busy; retry');
  }
  if (code === 'EMPLOYEE_ALREADY_HAS_NATIONAL_ID') {
    return new HttpError(409, 'EMPLOYEE_ALREADY_HAS_NATIONAL_ID', 'Employee already has a national_id linked');
  }
  return null;
}

function createEmployeeIdentityService({ repositories }) {
  const employeeIdentifiers = repositories.employeeIdentifiers;
  const employees = repositories.employees;

  async function resolveToEmployee(idType, idValue, ctx = {}) {
    const normalized = normalizeIdentifierValue(idType, idValue);
    if (!normalized) {
      if (idType === 'national_id') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
      }
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

    let link;
    try {
      link = await employeeIdentifiers.findActiveByTypeAndValue(idType, normalized, ctx);
    } catch (error) {
      throw mapProtectionError(error) || error;
    }
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

    /** `ctx` ({ actor, reason }) is audit metadata only — never put identifiers in it. */
    async resolve(identifierType, identifierValue, ctx = {}) {
      const idType = String(identifierType || '').trim();
      if (!isResolvableIdentifierType(idType)) {
        throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported identifier type: ${idType}`);
      }
      if (identifierValue == null || String(identifierValue).trim() === '') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'identifier value is required');
      }
      return resolveToEmployee(idType, identifierValue, ctx);
    },

    async resolveUid(identifierType, identifierValue, ctx = {}) {
      const employee = await this.resolve(identifierType, identifierValue, ctx);
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
      if (idType === 'national_id' && !normalized) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
      }
      if (!normalized) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'identifier value is required');
      }

      const employee = await employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      }

      // Identity kinds: personnel_id exists only when issued by MJU; HIP contractors never get a synthetic one.
      if (idType === 'personnel_id' && input.sourceSystem !== MJU_PERSONNEL_SOURCE) {
        throw new HttpError(400, 'PERSONNEL_ID_SOURCE_REQUIRED', 'personnel_id can only be linked from the MJU personnel source');
      }
      // A HIP code and a personnel_id with the same text must not belong to different employees.
      const counterpart = NAMESPACE_PAIR[idType];
      if (counterpart) {
        const other = await employeeIdentifiers.findActiveByTypeAndValue(counterpart, normalized);
        if (other && other.employeeUid !== employeeUid) {
          throw new HttpError(409, 'IDENTIFIER_NAMESPACE_COLLISION', 'Identifier value collides with another identity namespace');
        }
      }

      try {
        return await employeeIdentifiers.insert({
          employeeUid,
          idType,
          idValue: normalized,
          sourceSystem: input.sourceSystem ?? null,
          isPrimary: Boolean(input.isPrimary),
          verifiedAt: input.verifiedAt ?? null,
          actor: input.actor,
          reason: input.reason,
        });
      } catch (error) {
        const mapped = mapProtectionError(error);
        if (mapped) throw mapped;
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

    /** Derived identity kind (MJU / HIP / UNRESOLVED) + SSO policy; never creates or links anything. */
    async getIdentityKind(employeeUid) {
      if (!employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'employeeUid is required');
      }
      const rows = await employeeIdentifiers.listByEmployeeUid(employeeUid);
      const { kind, violations } = deriveIdentityKind(rows);
      return { employeeUid, kind, violations, sso: ssoPolicyForKind(kind) };
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
        // national_id is stored only as an HMAC lookup: no raw value (not even last 4) is recoverable.
        idValueMasked: row.idType === 'national_id' ? '[protected]' : maskIdentifierForLog(row.idType, row.idValue),
        lookupKeyVersion: row.idType === 'national_id' ? row.lookupKeyVersion ?? null : undefined,
        sourceSystem: row.sourceSystem,
        isPrimary: row.isPrimary,
        status: row.status,
        verifiedAt: row.verifiedAt,
      }));
    },
  };
}

module.exports = { createEmployeeIdentityService };
