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
  };
}

module.exports = { createAuthorizationMariaDbRepository };
