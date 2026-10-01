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
  };
}

module.exports = { createEmployeeMariaDbRepository };
