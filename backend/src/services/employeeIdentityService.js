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
const { NationalIdError } = require('../security/nationalIdContract');
const { HttpError } = require('../utils/httpError');

/**
 * @param {object} deps
 * @param {object} deps.repositories
 * @param {object} [deps.nationalIdProtector] versioned HMAC protector. REQUIRED for any national_id operation;
 *   an absent protector makes those operations fail closed rather than store plaintext (see `requireProtector`).
 */
function createEmployeeIdentityService({ repositories, nationalIdProtector = null }) {
  const employeeIdentifiers = repositories.employeeIdentifiers;
  const employees = repositories.employees;

  /**
   * A national ID may only ever be matched or stored as an HMAC digest. If no protector is configured the
   * feature is unavailable — never a plaintext fallback, which is the defect this guards against.
   */
  function requireProtector() {
    if (!nationalIdProtector) {
      throw new HttpError(
        503,
        'NATIONAL_ID_MATCHING_UNAVAILABLE',
        'national-ID matching requires a configured HMAC key',
      );
    }
    return nationalIdProtector;
  }

  /**
   * Converts a caller-supplied raw national ID into the digests a stored row could hold.
   * The raw value never leaves this function.
   */
  function nationalIdLookupCandidates(raw) {
    const candidates = requireProtector().lookupCandidates(raw);
    if (candidates.length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
    }
    return candidates;
  }

  async function resolveToEmployee(idType, idValue) {
    if (idType === 'national_id') {
      // Match on digests only. Every accepted key version is tried, so a row written before a rotation still
      // resolves; the raw value is discarded once the digests are computed.
      for (const candidate of nationalIdLookupCandidates(idValue)) {
        const link = await employeeIdentifiers.findActiveByTypeAndValue('national_id', candidate.lookup);
        if (link) {
          const employee = await employees.findByUid(link.employeeUid);
          if (!employee) {
            throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', notFoundMessage(idType));
          }
          return employee;
        }
      }
      throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', notFoundMessage(idType));
    }

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

      // A national ID is stored ONLY as a versioned HMAC digest. The raw value is hashed here and then goes out
      // of scope; nothing below this line can see it, so it cannot reach a column, a log or a response.
      let storedValue;
      let keyVersion = null;
      let maskedForLog;
      if (idType === 'national_id') {
        const activeProtector = requireProtector();
        let protectedValue;
        try {
          protectedValue = activeProtector.protect(idValue);
        } catch (error) {
          if (error instanceof NationalIdError && error.code === 'NATIONAL_ID_INVALID') {
            throw new HttpError(400, 'VALIDATION_ERROR', 'national_id must be 13 digits');
          }
          if (error instanceof NationalIdError) {
            throw new HttpError(503, 'NATIONAL_ID_MATCHING_UNAVAILABLE', 'national-ID matching is misconfigured');
          }
          throw error;
        }
        storedValue = protectedValue.lookup;
        keyVersion = protectedValue.keyVersion;
        maskedForLog = protectedValue.masked;

        /**
         * Cross-version duplicate guard.
         *
         * `UNIQUE (id_type, id_value)` compares digests, and a digest differs per key version — so the database
         * cannot see that a v1-era row and a v2 write are the SAME person. Migration
         * `015_employee_identifier_secure_lookup` says so in its header and delegates this check to the
         * application. Without it, a rotation lets two employees claim one national ID, which is exactly the
         * automatic identity merge F4 forbids. Every accepted version is therefore probed before inserting.
         */
        for (const candidate of activeProtector.lookupCandidates(idValue)) {
          const existing = await employeeIdentifiers.findActiveByTypeAndValue('national_id', candidate.lookup);
          if (!existing) continue;
          if (existing.employeeUid !== employeeUid) {
            throw new HttpError(409, 'DUPLICATE_IDENTIFIER', 'Identifier already linked to another employee');
          }
          // Same person, same ID: idempotent, and nothing new is written.
          return {
            id: existing.id ?? null,
            employeeUid,
            idType,
            idValueMasked: maskedForLog,
            lookupKeyVersion: existing.lookupKeyVersion ?? candidate.keyVersion,
            status: 'active',
          };
        }
      } else {
        const normalized = normalizeIdentifierValue(idType, idValue);
        if (!normalized) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'identifier value is required');
        }
        storedValue = normalized;
        maskedForLog = maskIdentifierForLog(idType, normalized);
      }

      const employee = await employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      }

      try {
        const inserted = await employeeIdentifiers.insert({
          employeeUid,
          idType,
          idValue: storedValue,
          lookupKeyVersion: keyVersion,
          sourceSystem: input.sourceSystem ?? null,
          isPrimary: Boolean(input.isPrimary),
          verifiedAt: input.verifiedAt ?? null,
        });
        // Only non-sensitive fields and the masked form are returned. Previously this echoed the inserted row,
        // including a raw national ID.
        return {
          id: inserted?.id ?? null,
          employeeUid,
          idType,
          idValueMasked: maskedForLog,
          lookupKeyVersion: keyVersion,
          status: inserted?.status ?? 'active',
        };
      } catch (error) {
        if (error.code === 'DUPLICATE_IDENTIFIER') {
          throw new HttpError(409, 'DUPLICATE_IDENTIFIER', 'Identifier already linked to another employee');
        }
        if (error.code === 'UNKNOWN_EMPLOYEE') {
          throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
        }
        // A national ID needs `employee_identifier.lookup_key_version`, which only migration
        // 015_employee_identifier_secure_lookup adds. Without it the write is impossible, and a raw
        // "Unknown column" error would look like a bug rather than a missing migration.
        if (idType === 'national_id' && error.code === 'ER_BAD_FIELD_ERROR') {
          throw new HttpError(
            503,
            'NATIONAL_ID_STORAGE_NOT_READY',
            'national-ID storage requires migration 015_employee_identifier_secure_lookup',
          );
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
        // A national_id row holds a digest, so its "last four" would be four hex characters of the HMAC, not
        // four digits of the citizen's ID. Nothing about the raw value survives, so there is no mask to show.
        idValueMasked: row.idType === 'national_id' ? null : maskIdentifierForLog(row.idType, row.idValue),
        sourceSystem: row.sourceSystem,
        isPrimary: row.isPrimary,
        status: row.status,
        verifiedAt: row.verifiedAt,
      }));
    },
  };
}

module.exports = { createEmployeeIdentityService };
