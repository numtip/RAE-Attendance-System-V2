class LeaveRepository {
  constructor(leaveRows, balanceRows) {
    this.leaveRows = leaveRows;
    this.balanceRows = balanceRows;
  }

  async list(employeeUid) {
    return this.leaveRows.filter((row) => row.employeeUid === employeeUid);
  }

  async countAll() {
    return this.leaveRows.length;
  }

  async listOverlapping(start, end) {
    return this.leaveRows.filter((row) => row.startDate <= end && row.endDate >= start);
  }

  async history(employeeUid) {
    return this.list(employeeUid);
  }

  async balance(employeeUid, year) {
    return this.balanceRows.filter((row) => row.employeeUid === employeeUid && row.year === year);
  }
}

module.exports = { LeaveRepository };
