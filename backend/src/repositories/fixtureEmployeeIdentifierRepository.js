const {
  normalizeIdentifierValue,
  isStoredIdentifierType,
} = require('../domain/employeeIdentifier');
const { isEffectiveOnDate } = require('../domain/identifierValidity');
const { NAMESPACE_PAIR } = require('../domain/identityKind');
const {
  IdentifierCryptoError,
  buildAuditEvent,
  createNationalIdProtector,
} = require('../security/nationalIdContract');

function mapRecord(record) {
  return {
    id: record.id,
    employeeUid: record.employeeUid,
    idType: record.idType,
    // national_id rows hold only an HMAC lookup and never leave the repository.
    idValue: record.idType === 'national_id' ? null : record.idValue,
    lookupKeyVersion: record.idType === 'national_id' ? record.lookupKeyVersion ?? null : undefined,
    sourceSystem: record.sourceSystem,
    isPrimary: record.isPrimary,
    status: record.status,
    verifiedAt: record.verifiedAt,
    effectiveFrom: record.effectiveFrom ?? null,
    effectiveTo: record.effectiveTo ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function createFixtureEmployeeIdentifierRepository(initialRows = [], { nationalId = null } = {}) {
  let nextId = 1;
  let protector = nationalId;
  let seeded = false;
  const getProtector = () => {
    if (!protector) protector = createNationalIdProtector(process.env);
    protectSeedNationalRows(protector);
    return protector;
  };
  const auditLog = [];
  const audit = (fields) => auditLog.push(buildAuditEvent({ actor: 'system:identity-service', ...fields }));
  const rows = initialRows.map((row) => ({
    id: nextId++,
    isPrimary: false,
    status: 'active',
    sourceSystem: null,
    verifiedAt: null,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...row,
  }));

  /**
   * Seed fixtures may list a SYNTHETIC national_id in plain text for readability. It is converted to the HMAC
   * lookup (current key) the first time protection is needed, so the repository never serves or compares plaintext.
   * Unconfigured keys => NOT_CONFIGURED (fail closed), same as production.
   */
  function protectSeedNationalRows(p) {
    if (seeded) return;
    for (const row of rows) {
      if (row.idType === 'national_id' && /^\d{13}$/.test(String(row.idValue))) {
        const current = p.lookupCurrent(row.idValue);
        row.idValue = current.lookup_hmac;
        row.lookupKeyVersion = current.key_version;
      }
    }
    seeded = true;
  }

  function findActiveNational(idValue) {
    const candidates = getProtector().lookupCandidates(idValue).map((c) => c.lookup_hmac);
    return rows.find(
      (row) => row.status === 'active' && row.idType === 'national_id' && candidates.includes(row.idValue),
    ) || null;
  }

  function findActiveRow(idType, idValue, onDate = null) {
    let row = null;
    if (idType === 'national_id') {
      if (!idValue) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
      row = findActiveNational(idValue);
    } else {
      const normalizedValue = normalizeIdentifierValue(idType, idValue);
      row = rows.find(
        (item) => item.status === 'active'
          && item.idType === idType
          && item.idValue === normalizedValue,
      ) || null;
    }
    if (!row) return null;
    // Effective-dated mapping: onDate === null keeps the pre-020 behaviour (no date filter).
    return isEffectiveOnDate(row, onDate) ? row : null;
  }

  return {
    async findActiveByTypeAndValue(idType, idValue, ctx = {}) {
      const normalized = idType === 'national_id' ? normalizeIdentifierValue(idType, idValue) : idValue;
      const row = findActiveRow(idType, normalized, ctx.onDate ?? null);
      if (idType === 'national_id') {
        audit({
          action: 'lookup',
          actor: ctx.actor || 'system:identity-service',
          reason: ctx.reason || (row ? 'resolve:hit' : 'resolve:miss'),
          keyVersion: row?.lookupKeyVersion ?? null,
          employeeUid: row?.employeeUid ?? null,
          identifierId: row?.id ?? null,
        });
      }
      return row ? mapRecord(row) : null;
    },

    /** Test hook: metadata-only audit rows. */
    listAudit() {
      return auditLog.map((event) => ({ ...event }));
    },

    async listByEmployeeUid(employeeUid, { includeInactive = false } = {}) {
      return rows
        .filter((row) => row.employeeUid === employeeUid && (includeInactive || row.status === 'active'))
        .map(mapRecord);
    },

    async insert(input) {
      if (!isStoredIdentifierType(input.idType)) {
        const error = new Error('INVALID_IDENTIFIER_TYPE');
        error.code = 'INVALID_IDENTIFIER_TYPE';
        throw error;
      }
      const idValue = normalizeIdentifierValue(input.idType, input.idValue);
      if (input.idType === 'national_id') {
        if (!idValue) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
        const p = getProtector();
        p.assertWritable();
        const current = p.lookupCurrent(idValue);
        const candidates = p.lookupCandidates(idValue).map((c) => c.lookup_hmac);
        const sameValue = rows.find((row) => row.idType === 'national_id' && candidates.includes(row.idValue));
        if (sameValue) {
          if (sameValue.employeeUid === input.employeeUid && sameValue.status === 'active') return mapRecord(sameValue);
          const error = new Error('DUPLICATE_IDENTIFIER');
          error.code = 'DUPLICATE_IDENTIFIER';
          throw error;
        }
        if (rows.some((row) => row.idType === 'national_id' && row.employeeUid === input.employeeUid)) {
          const error = new Error('EMPLOYEE_ALREADY_HAS_NATIONAL_ID');
          error.code = 'EMPLOYEE_ALREADY_HAS_NATIONAL_ID';
          throw error;
        }
        const stamp = new Date().toISOString();
        const record = {
          id: nextId++,
          employeeUid: input.employeeUid,
          idType: 'national_id',
          idValue: current.lookup_hmac,
          lookupKeyVersion: current.key_version,
          sourceSystem: input.sourceSystem ?? null,
          isPrimary: Boolean(input.isPrimary),
          status: 'active',
          verifiedAt: input.verifiedAt ?? null,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveTo: input.effectiveTo ?? null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        rows.push(record);
        audit({
          action: 'create',
          actor: input.actor || 'system:identity-service',
          reason: input.reason || 'link:national_id',
          keyVersion: current.key_version,
          employeeUid: input.employeeUid,
          identifierId: record.id,
          effectiveFrom: record.effectiveFrom,
          effectiveTo: record.effectiveTo,
        });
        return mapRecord(record);
      }
      const existing = findActiveRow(input.idType, idValue);
      if (existing) {
        if (existing.employeeUid === input.employeeUid) {
          return mapRecord(existing);
        }
        const error = new Error('DUPLICATE_IDENTIFIER');
        error.code = 'DUPLICATE_IDENTIFIER';
        throw error;
      }
      // Parity with migration 017: facescan_id/personnel_id text is owned by ONE employee across both types.
      if (NAMESPACE_PAIR[input.idType]) {
        const clash = rows.some((row) => row.idType === NAMESPACE_PAIR[input.idType]
          && row.idValue === idValue && row.employeeUid !== input.employeeUid);
        if (clash) {
          const error = new Error('IDENTIFIER_NAMESPACE_COLLISION');
          error.code = 'IDENTIFIER_NAMESPACE_COLLISION';
          throw error;
        }
      }
      const now = new Date().toISOString();
      const record = {
        id: nextId++,
        employeeUid: input.employeeUid,
        idType: input.idType,
        idValue,
        sourceSystem: input.sourceSystem ?? null,
        isPrimary: Boolean(input.isPrimary),
        status: 'active',
        verifiedAt: input.verifiedAt ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(record);
      return mapRecord(record);
    },

    async deactivate(id, employeeUid, { effectiveTo = null } = {}) {
      const row = rows.find((item) => item.id === id && item.employeeUid === employeeUid);
      if (!row || row.status === 'inactive') {
        return false;
      }
      row.status = 'inactive';
      // Optional: close the validity window at the same time as the deactivation.
      if (effectiveTo != null) row.effectiveTo = effectiveTo;
      row.updatedAt = new Date().toISOString();
      return true;
    },

    /** Metadata-only validity change (no identifier value). Mirrors the MariaDB audit append. */
    async recordValidityEvent(input) {
      const event = buildAuditEvent({
        action: 'effective_change',
        actor: input.actor || 'system:identity-service',
        reason: input.reason || 'validity:change',
        employeeUid: input.employeeUid ?? null,
        identifierId: input.identifierId ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
      });
      auditLog.push(event);
      return {
        action: event.action,
        actor: event.actor,
        reason: event.reason,
        employeeUid: event.employee_uid,
        identifierId: event.identifier_id,
        effectiveFrom: event.effective_from,
        effectiveTo: event.effective_to,
      };
    },

    async listValidityEvents({ employeeUid = null, limit = 50 } = {}) {
      return auditLog
        .filter((event) => event.action === 'effective_change')
        .filter((event) => !employeeUid || event.employee_uid === employeeUid)
        .slice(-Number(limit))
        .reverse()
        .map((event) => ({
          identifierId: event.identifier_id ?? null,
          employeeUid: event.employee_uid ?? null,
          action: event.action,
          effectiveFrom: event.effective_from ?? null,
          effectiveTo: event.effective_to ?? null,
          actor: event.actor,
          reason: event.reason,
          createdAt: event.created_at,
        }));
    },
  };
}

module.exports = { createFixtureEmployeeIdentifierRepository };
