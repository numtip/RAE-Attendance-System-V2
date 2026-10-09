const {
  normalizeIdentifierValue,
  isStoredIdentifierType,
} = require('../domain/employeeIdentifier');

function mapRecord(record) {
  return {
    id: record.id,
    employeeUid: record.employeeUid,
    idType: record.idType,
    idValue: record.idValue,
    sourceSystem: record.sourceSystem,
    isPrimary: record.isPrimary,
    status: record.status,
    verifiedAt: record.verifiedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function createFixtureEmployeeIdentifierRepository(initialRows = []) {
  let nextId = 1;
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

  function findActiveRow(idType, idValue) {
    const normalizedValue = normalizeIdentifierValue(idType, idValue);
    return rows.find(
      (row) => row.status === 'active'
        && row.idType === idType
        && row.idValue === normalizedValue,
    ) || null;
  }

  return {
    async findActiveByTypeAndValue(idType, idValue) {
      const row = findActiveRow(idType, idValue);
      return row ? mapRecord(row) : null;
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
