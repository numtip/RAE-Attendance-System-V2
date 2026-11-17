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

  /**
   * Upsert by (employeeUid, date) — the same key the MariaDB unique index enforces, so a correction
   * replaces the day instead of appending a second one. Arrays are replaced, never mutated: the
   * fixture data is shared by every test in the process.
   */
  async upsertDay(record) {
    const index = this.dailyRows.findIndex((row) => (
      row.employeeUid === record.employeeUid && row.date === record.date
    ));
    if (index === -1) {
      this.dailyRows = [...this.dailyRows, record];
      return record;
    }
    const merged = { ...this.dailyRows[index], ...record };
    this.dailyRows = this.dailyRows.map((row, i) => (i === index ? merged : row));
    return merged;
  }

  async upsertMonthly(summary) {
    const index = this.monthlyRows.findIndex((row) => (
      row.employeeUid === summary.employeeUid && row.year === summary.year && row.month === summary.month
    ));
    if (index === -1) {
      this.monthlyRows = [...this.monthlyRows, summary];
      return summary;
    }
    const merged = { ...this.monthlyRows[index], ...summary };
    this.monthlyRows = this.monthlyRows.map((row, i) => (i === index ? merged : row));
    return merged;
  }
}

module.exports = { AttendanceRepository };
