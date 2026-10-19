function overlapsMonth(row, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return row.startDate <= last && row.endDate >= start;
}

function createReportService(attendanceService, leaveService) {
  return {
    async personal(auth, year, month) {
      const employeeUid = auth.employeeUid;
      const monthly = await attendanceService.monthly(auth, employeeUid, year, month);
      const leave = await leaveService.list(auth, employeeUid);
      const balance = await leaveService.balance(auth, employeeUid, year);
      const leaveInMonth = leave.filter((row) => overlapsMonth(row, year, month));
      const remainingLeaveDays = balance.reduce((sum, row) => sum + Number(row.remainingDays || 0), 0);
      return {
        employeeUid,
        year,
        month,
        present: monthly.totalPresent,
        late: monthly.totalLate,
        absent: monthly.totalAbsent,
        leaveDaysOnSummary: monthly.totalLeave,
        workDays: monthly.totalWorkDays,
        leaveRowsInMonth: leaveInMonth.length,
        remainingLeaveDays,
        source: 'stored-monthly-and-leave',
      };
    },
  };
}

module.exports = { createReportService };
