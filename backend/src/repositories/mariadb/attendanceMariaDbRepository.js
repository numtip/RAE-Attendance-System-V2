const { mapRow, mapRows } = require('./rowMapper');

function createAttendanceMariaDbRepository(pool) {
  return {
    async findDaily(date) {
      const [rows] = await pool.query(
        `SELECT employee_uid, date, check_in, check_out, is_late, late_minutes, work_duration, status
         FROM daily_attendance WHERE date = ? ORDER BY employee_uid`,
        [date],
      );
      return mapRows(rows);
    },

    async findMonthly(employeeUid, year, month) {
      const [rows] = await pool.query(
        `SELECT employee_uid, year, month, total_work_days, total_present, total_late, total_absent,
                total_leave, total_late_minutes, total_work_hours
         FROM monthly_summary
         WHERE employee_uid = ? AND year = ? AND month = ?
         LIMIT 1`,
        [employeeUid, year, month],
      );
      return mapRow(rows[0]);
    },

    async findForEmployee(employeeUid) {
      const [rows] = await pool.query(
        `SELECT employee_uid, date, check_in, check_out, is_late, late_minutes, work_duration, status
         FROM daily_attendance WHERE employee_uid = ? ORDER BY date DESC`,
        [employeeUid],
      );
      return mapRows(rows);
    },
  };
}

module.exports = { createAttendanceMariaDbRepository };
