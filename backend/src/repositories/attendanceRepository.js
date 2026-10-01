class AttendanceRepository {
  constructor(dailyRows, monthlyRows) {
    this.dailyRows = dailyRows;
    this.monthlyRows = monthlyRows;
  }

  async findDaily(date) {
    return this.dailyRows.filter((row) => row.date === date);
  }

  async findMonthly(employeeUid, year, month) {
    return this.monthlyRows.find((row) => (
      row.employeeUid === employeeUid && row.year === year && row.month === month
    )) || null;
  }

  async findForEmployee(employeeUid) {
    return this.dailyRows.filter((row) => row.employeeUid === employeeUid);
  }
}

module.exports = { AttendanceRepository };
