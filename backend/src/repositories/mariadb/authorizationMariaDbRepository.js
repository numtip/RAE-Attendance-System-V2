function isMissingTable(error) {
  return error && (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146);
}

function createAuthorizationMariaDbRepository(pool) {
  async function queryOrEmpty(sql, params) {
    try {
      const [rows] = await pool.query(sql, params);
      return rows;
    } catch (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
  }

  return {
    async grantsFor(employeeUid) {
      const rows = await queryOrEmpty(
        `SELECT employee_uid AS employeeUid, role, scope_type AS scopeType, org_unit_code AS orgUnitCode
         FROM authorization_grants WHERE employee_uid = ?`,
        [employeeUid],
      );
      return rows;
    },
    async uidsInOrgUnits(orgUnitCodes) {
      if (!orgUnitCodes.length) return [];
      const marks = orgUnitCodes.map(() => '?').join(', ');
      const rows = await queryOrEmpty(
        `SELECT employee_uid AS employeeUid FROM employee_org_membership WHERE org_unit_code IN (${marks})`,
        orgUnitCodes,
      );
      return rows.map((row) => row.employeeUid);
    },
    /** Idempotent: the (employee_uid, org_unit_code) unique key makes a repeat a no-op. */
    async addMembership(employeeUid, orgUnitCode) {
      const [result] = await pool.query(
        'INSERT IGNORE INTO employee_org_membership (employee_uid, org_unit_code, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
        [employeeUid, orgUnitCode],
      );
      return result.affectedRows === 1;
    },
    async listMemberships() {
      return queryOrEmpty(
        'SELECT employee_uid AS employeeUid, org_unit_code AS orgUnitCode FROM employee_org_membership',
        [],
      );
    },
  };
}

module.exports = { createAuthorizationMariaDbRepository };
