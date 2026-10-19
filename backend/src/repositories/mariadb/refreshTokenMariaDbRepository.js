const { randomUUID } = require('node:crypto');
const { mapRow } = require('./rowMapper');
const { hashRefreshToken } = require('../../security/refreshTokenHash');

function createRefreshTokenMariaDbRepository(pool) {
  async function withTransaction(work) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* surface the original error */ }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function lockByRaw(connection, raw) {
    const hash = hashRefreshToken(raw);
    const [rows] = await connection.query(
      `SELECT rt.id, rt.employee_uid, rt.family_id, rt.expires_at, rt.revoked_at, e.email, e.role
       FROM refresh_tokens rt
       INNER JOIN employees e ON e.employee_uid = rt.employee_uid
       WHERE rt.token_hash = ? OR (rt.token_hash IS NULL AND rt.token = ?)
       LIMIT 1
       FOR UPDATE`,
      [hash, raw],
    );
    return rows[0] || null;
  }

  return {
    async save(record) {
      const familyId = record.familyId || randomUUID();
      const [result] = await pool.query(
        `INSERT INTO refresh_tokens (
           employee_uid, token, token_hash, family_id, expires_at, created_at, revoked_at
         ) VALUES (?, NULL, ?, ?, ?, UTC_TIMESTAMP(), NULL)`,
        [record.employeeUid, hashRefreshToken(record.token), familyId, new Date(record.expiresAt)],
      );
      return result.insertId;
    },

    async find(raw) {
      const hash = hashRefreshToken(raw);
      const [rows] = await pool.query(
        `SELECT rt.id, rt.employee_uid, rt.family_id, rt.expires_at, rt.created_at, rt.revoked_at,
                e.email, e.role
         FROM refresh_tokens rt
         INNER JOIN employees e ON e.employee_uid = rt.employee_uid
         WHERE rt.token_hash = ? OR (rt.token_hash IS NULL AND rt.token = ?)
         LIMIT 1`,
        [hash, raw],
      );
      return mapRow(rows[0]);
    },

    async revoke(raw) {
      return withTransaction(async (connection) => {
        const current = await lockByRaw(connection, raw);
        if (!current) return false;
        if (current.family_id) {
          await connection.query(
            `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP()
             WHERE family_id = ? AND revoked_at IS NULL`,
            [current.family_id],
          );
        } else if (!current.revoked_at) {
          await connection.query(
            `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL`,
            [current.id],
          );
        }
        return true;
      });
    },

    async rotate(raw) {
      const connection = await pool.getConnection();
      const hash = hashRefreshToken(raw);
      let locked = false;
      try {
        const [locks] = await connection.query('SELECT GET_LOCK(?, 0) AS got', [hash]);
        if (locks[0].got == null) throw new Error('refresh lock unavailable');
        if (Number(locks[0].got) !== 1) return { outcome: 'lost_race' };
        locked = true;
        await connection.beginTransaction();
        const current = await lockByRaw(connection, raw);
        if (!current || new Date(current.expires_at).getTime() <= Date.now()) {
          await connection.commit();
          return { outcome: 'invalid' };
        }
        if (current.revoked_at) {
          if (current.family_id) {
            await connection.query(
              `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP()
               WHERE family_id = ? AND revoked_at IS NULL`,
              [current.family_id],
            );
          }
          await connection.commit();
          return { outcome: 'reused' };
        }
        const familyId = current.family_id || randomUUID();
        const [updated] = await connection.query(
          `UPDATE refresh_tokens
           SET revoked_at = UTC_TIMESTAMP(), family_id = ?
           WHERE id = ? AND revoked_at IS NULL`,
          [familyId, current.id],
        );
        if (updated.affectedRows !== 1) {
          await connection.commit();
          return { outcome: 'reused' };
        }
        const successor = randomUUID();
        await connection.query(
          `INSERT INTO refresh_tokens (
             employee_uid, token, token_hash, family_id, parent_id, expires_at, created_at, revoked_at
           ) VALUES (?, NULL, ?, ?, ?, ?, UTC_TIMESTAMP(), NULL)`,
          [current.employee_uid, hashRefreshToken(successor), familyId, current.id, current.expires_at],
        );
        await connection.commit();
        return {
          outcome: 'rotated',
          refreshToken: successor,
          employeeUid: current.employee_uid,
          role: current.role,
          email: current.email,
          expiresAt: current.expires_at,
        };
      } catch (error) {
        try { await connection.rollback(); } catch { /* surface the original error */ }
        throw error;
      } finally {
        if (locked) {
          try { await connection.query('SELECT RELEASE_LOCK(?)', [hash]); } catch { /* connection is closing */ }
        }
        connection.release();
      }
    },
  };
}

module.exports = { createRefreshTokenMariaDbRepository };
