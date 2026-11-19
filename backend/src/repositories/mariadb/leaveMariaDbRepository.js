const { mapRows } = require('./rowMapper');

function createLeaveMariaDbRepository(pool) {
  return {
    async list(employeeUid) {
      const [rows] = await pool.query(
        `SELECT leave_id, employee_uid, leave_type, start_date, end_date, status, match_status
         FROM employee_leave WHERE employee_uid = ? ORDER BY start_date DESC`,
        [employeeUid],
      );
      return mapRows(rows);
    },

    async countAll() {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM employee_leave');
      return Number(rows[0].n);
    },

    async listOverlapping(start, end) {
      const [rows] = await pool.query(
        `SELECT leave_id, employee_uid, leave_type, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
                DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status, match_status
         FROM employee_leave WHERE start_date <= ? AND end_date >= ? ORDER BY start_date`,
        [end, start],
      );
      return mapRows(rows);
    },

    async history(employeeUid) {
      return this.list(employeeUid);
    },

    async balance(employeeUid, year) {
      const [rows] = await pool.query(
        `SELECT employee_uid, year, leave_type, total_days, used_days, remaining_days
         FROM leave_balance WHERE employee_uid = ? AND year = ? ORDER BY leave_type`,
        [employeeUid, year],
      );
      return mapRows(rows);
    },
  };
}

module.exports = { createLeaveMariaDbRepository };
