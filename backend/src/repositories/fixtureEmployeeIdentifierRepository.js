const {
  normalizeIdentifierValue,
  isStoredIdentifierType,
} = require('../domain/employeeIdentifier');
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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function createFixtureEmployeeIdentifierRepository(initialRows = [], { nationalId = null } = {}) {
  let nextId = 1;
  let protector = nationalId;
  const getProtector = () => {
    if (!protector) protector = createNationalIdProtector(process.env);
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...row,
  }));

  function findActiveNational(idValue) {
    const candidates = getProtector().lookupCandidates(idValue).map((c) => c.lookup_hmac);
    return rows.find(
      (row) => row.status === 'active' && row.idType === 'national_id' && candidates.includes(row.idValue),
    ) || null;
  }

  function findActiveRow(idType, idValue) {
    if (idType === 'national_id') {
      if (!idValue) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
      return findActiveNational(idValue);
    }
    const normalizedValue = normalizeIdentifierValue(idType, idValue);
    return rows.find(
      (row) => row.status === 'active'
        && row.idType === idType
        && row.idValue === normalizedValue,
    ) || null;
  }

  return {
    async findActiveByTypeAndValue(idType, idValue, ctx = {}) {
      const normalized = idType === 'national_id' ? normalizeIdentifierValue(idType, idValue) : idValue;
      const row = findActiveRow(idType, normalized);
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
        createdAt: now,
        updatedAt: now,
      };
      rows.push(record);
      return mapRecord(record);
    },

    async deactivate(id, employeeUid) {
      const row = rows.find((item) => item.id === id && item.employeeUid === employeeUid);
      if (!row || row.status === 'inactive') {
        return false;
      }
      row.status = 'inactive';
      row.updatedAt = new Date().toISOString();
      return true;
    },
  };
}

module.exports = { createFixtureEmployeeIdentifierRepository };
