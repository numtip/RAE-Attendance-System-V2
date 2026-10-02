const { mapRow } = require('./rowMapper');
const {
  normalizeIdentifierValue,
  isStoredIdentifierType,
} = require('../../domain/employeeIdentifier');

function mapIdentifier(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    id: mapped.id,
    employeeUid: mapped.employeeUid,
    idType: mapped.idType,
    idValue: mapped.idValue,
    sourceSystem: mapped.sourceSystem,
    isPrimary: Boolean(mapped.isPrimary),
    status: mapped.status,
    verifiedAt: mapped.verifiedAt ? new Date(mapped.verifiedAt).toISOString() : null,
    createdAt: new Date(mapped.createdAt).toISOString(),
    updatedAt: new Date(mapped.updatedAt).toISOString(),
  };
}

function createEmployeeIdentifierMariaDbRepository(pool) {
  return {
    async findActiveByTypeAndValue(idType, idValue) {
      const normalized = normalizeIdentifierValue(idType, idValue);
      const [rows] = await pool.query(
        `SELECT id, employee_uid, id_type, id_value, source_system, is_primary, status, verified_at, created_at, updated_at
         FROM employee_identifier
         WHERE id_type = ? AND id_value = ? AND status = 'active'
         LIMIT 1`,
        [idType, normalized],
      );
      return mapIdentifier(rows[0]);
    },

    async listByEmployeeUid(employeeUid, { includeInactive = false } = {}) {
      const statusClause = includeInactive ? '' : " AND status = 'active'";
      const [rows] = await pool.query(
        `SELECT id, employee_uid, id_type, id_value, source_system, is_primary, status, verified_at, created_at, updated_at
         FROM employee_identifier
         WHERE employee_uid = ?${statusClause}
         ORDER BY id_type, id_value`,
        [employeeUid],
      );
      return rows.map((row) => mapIdentifier(row));
    },

    async insert(input) {
      if (!isStoredIdentifierType(input.idType)) {
        const error = new Error('INVALID_IDENTIFIER_TYPE');
        error.code = 'INVALID_IDENTIFIER_TYPE';
        throw error;
      }
      const idValue = normalizeIdentifierValue(input.idType, input.idValue);
      const now = new Date();
      try {
        const [result] = await pool.query(
          `INSERT INTO employee_identifier (
             employee_uid, id_type, id_value, source_system, is_primary, status, verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [
            input.employeeUid,
            input.idType,
            idValue,
            input.sourceSystem ?? null,
            input.isPrimary ? 1 : 0,
            input.verifiedAt ?? null,
            now,
            now,
          ],
        );
        const [rows] = await pool.query(
          `SELECT id, employee_uid, id_type, id_value, source_system, is_primary, status, verified_at, created_at, updated_at
           FROM employee_identifier WHERE id = ? LIMIT 1`,
          [result.insertId],
        );
        return mapIdentifier(rows[0]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          const existing = await this.findActiveByTypeAndValue(input.idType, idValue);
          if (existing && existing.employeeUid === input.employeeUid) {
            return existing;
          }
          const dup = new Error('DUPLICATE_IDENTIFIER');
          dup.code = 'DUPLICATE_IDENTIFIER';
          throw dup;
        }
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
          const missing = new Error('UNKNOWN_EMPLOYEE');
          missing.code = 'UNKNOWN_EMPLOYEE';
          throw missing;
        }
        throw error;
      }
    },

    async deactivate(id, employeeUid) {
      const [result] = await pool.query(
        `UPDATE employee_identifier
         SET status = 'inactive', updated_at = ?
         WHERE id = ? AND employee_uid = ? AND status = 'active'`,
        [new Date(), id, employeeUid],
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createEmployeeIdentifierMariaDbRepository };
