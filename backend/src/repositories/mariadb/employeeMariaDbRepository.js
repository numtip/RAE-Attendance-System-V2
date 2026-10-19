const { publicFields } = require('../employeeMapper');
const { mapRow, mapRows } = require('./rowMapper');

function createEmployeeMariaDbRepository(pool) {
  return {
    async findByEmail(email) {
      const [rows] = await pool.query(
        `SELECT employee_uid, employee_id, first_name_th, last_name_th, first_name_en, last_name_en,
                email, password_hash, last_login, login_attempts, locked_until, phone, department,
                position, employee_type, hire_date, status, role, created_at, updated_at
         FROM employees WHERE email = ? LIMIT 1`,
        [email],
      );
      return mapRow(rows[0]);
    },

    async findByEmployeeId(employeeId) {
      const normalized = String(employeeId || '').trim();
      if (!normalized) return null;
      const [rows] = await pool.query(
        `SELECT employee_uid, employee_id, first_name_th, last_name_th, first_name_en, last_name_en,
                email, password_hash, last_login, login_attempts, locked_until, phone, department,
                position, employee_type, hire_date, status, role, created_at, updated_at
         FROM employees WHERE employee_id = ? LIMIT 1`,
        [normalized],
      );
      return mapRow(rows[0]);
    },

    async findByUid(employeeUid) {
      const [rows] = await pool.query(
        `SELECT employee_uid, employee_id, first_name_th, last_name_th, email, department,
                position, employee_type, status, role
         FROM employees WHERE employee_uid = ? LIMIT 1`,
        [employeeUid],
      );
      const row = mapRow(rows[0]);
      return row ? publicFields(row) : null;
    },

    async list() {
      const [rows] = await pool.query(
        `SELECT employee_uid, employee_id, first_name_th, last_name_th, email, department,
                position, employee_type, status, role
         FROM employees ORDER BY employee_id`,
      );
      return mapRows(rows).map(publicFields);
    },

    async recordFailedLogin(employeeUid, { maxAttempts, lockMs }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT login_attempts, locked_until
           FROM employees WHERE employee_uid = ? FOR UPDATE`,
          [employeeUid],
        );
        const current = rows[0];
        if (!current) {
          await connection.rollback();
          return { updated: false };
        }
        const lockedUntil = current.locked_until ? new Date(current.locked_until).getTime() : null;
        const nowMs = Date.now();
        if (lockedUntil != null && lockedUntil > nowMs) {
          await connection.rollback();
          return { updated: false, locked: true, loginAttempts: current.login_attempts || 0 };
        }
        const attempts = (lockedUntil != null && lockedUntil <= nowMs ? 0 : (current.login_attempts || 0)) + 1;
        const nextLock = attempts >= maxAttempts ? new Date(nowMs + lockMs) : null;
        await connection.query(
          `UPDATE employees SET login_attempts = ?, locked_until = ? WHERE employee_uid = ?`,
          [attempts, nextLock, employeeUid],
        );
        await connection.commit();
        return { updated: true, locked: Boolean(nextLock), loginAttempts: attempts };
      } catch (error) {
        try { await connection.rollback(); } catch { /* the original error is the one to surface */ }
        throw error;
      } finally {
        connection.release();
      }
    },

    async clearLoginAttempts(employeeUid) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT locked_until FROM employees WHERE employee_uid = ? FOR UPDATE`,
          [employeeUid],
        );
        const current = rows[0];
        if (!current) {
          await connection.rollback();
          return false;
        }
        const lockedUntil = current.locked_until ? new Date(current.locked_until).getTime() : null;
        if (lockedUntil != null && lockedUntil > Date.now()) {
          await connection.rollback();
          return false;
        }
        await connection.query(
          `UPDATE employees SET login_attempts = 0, locked_until = NULL WHERE employee_uid = ?`,
          [employeeUid],
        );
        await connection.commit();
        return true;
      } catch (error) {
        try { await connection.rollback(); } catch { /* the original error is the one to surface */ }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

module.exports = { createEmployeeMariaDbRepository };
