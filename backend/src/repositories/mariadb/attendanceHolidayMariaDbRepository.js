function createAttendanceHolidayMariaDbRepository(pool) {
  return {
    async listAll(start, end) {
      const [rows] = await pool.query(`SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS date,
        name, scope, status, source_reference AS sourceReference FROM attendance_holiday
        WHERE holiday_date BETWEEN ? AND ? AND scope IN ('national', 'university') ORDER BY holiday_date, id`, [start, end]);
      return rows;
    },
    async listApproved(start, end) {
      const [rows] = await pool.query(
        `SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS date, name, source_reference AS sourceReference
           FROM attendance_holiday WHERE status = 'approved' AND scope IN ('national', 'university')
             AND holiday_date BETWEEN ? AND ? ORDER BY holiday_date`, [start, end],
      );
      return rows;
    },
  };
}
module.exports = { createAttendanceHolidayMariaDbRepository };
