/**
 * Fixture daily + monthly attendance reads.
 *
 * `monthlyStore` is optional and exists to REMOVE a fixture-only divergence: Slice 3 introduced a
 * monthly_summary writer, so if this class kept reading its own static array the legacy
 * `GET /attendance/monthly/:uid/:year/:month` route would keep showing the seeded month while the new
 * derived endpoints showed the recomputed one. Passing the same store means both read one source.
 */
class AttendanceRepository {
  constructor(dailyRows, monthlyRows, monthlyStore = null) {
    this.dailyRows = dailyRows;
    this.monthlyRows = monthlyRows;
    this.monthlyStore = monthlyStore;
  }

  async findDaily(date) {
    return this.dailyRows.filter((row) => row.date === date);
  }

  async findMonthly(employeeUid, year, month) {
    if (this.monthlyStore) {
      return this.monthlyStore.findForEmployeeMonth(employeeUid, year, month);
    }
    return this.monthlyRows.find((row) => (
      row.employeeUid === employeeUid && row.year === year && row.month === month
    )) || null;
  }

  async findForEmployee(employeeUid) {
    return this.dailyRows.filter((row) => row.employeeUid === employeeUid);
  }
}

module.exports = { AttendanceRepository };
