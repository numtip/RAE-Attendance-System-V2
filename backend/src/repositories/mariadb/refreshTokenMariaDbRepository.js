const { mapRow } = require('./rowMapper');

function createRefreshTokenMariaDbRepository(pool) {
  return {
    async save(record) {
      const expiresAt = record.expiresAt instanceof Date
        ? record.expiresAt
        : new Date(record.expiresAt);
      const [result] = await pool.query(
        `INSERT INTO refresh_tokens (employee_uid, token, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), NULL)`,
        [record.employeeUid, record.token, expiresAt],
      );
      return result.insertId;
    },

    async find(token) {
      const [rows] = await pool.query(
        `SELECT rt.id, rt.employee_uid, rt.token, rt.expires_at, rt.created_at, rt.revoked_at,
                e.email, e.role
         FROM refresh_tokens rt
         INNER JOIN employees e ON e.employee_uid = rt.employee_uid
         WHERE rt.token = ?
         LIMIT 1`,
        [token],
      );
      return mapRow(rows[0]);
    },

    async revoke(token) {
      const [result] = await pool.query(
        `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP()
         WHERE token = ? AND revoked_at IS NULL`,
        [token],
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createRefreshTokenMariaDbRepository };
