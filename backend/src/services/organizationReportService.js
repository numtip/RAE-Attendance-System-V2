const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');
const { recordedLeaveByEmployee } = require('./recordedLeave');
const { dataThrough } = require('./dataThrough');
const { writeXlsx } = require('./export/xlsxWriter');
const { renderOrganizationPdf } = require('./export/organizationPdf');

const { HOLIDAY_NOTE, assertPeriod, monthBounds, thaiDate } = reportHelpers;

/**
 * Release 2 / M1 — organization and team attendance report.
 *
 * Access is the same authorization every other attendance read uses (`resolveScope('data')`):
 *   EXECUTIVE with an organization grant -> every employee;
 *   MANAGER with org-unit grants         -> the granted unit's members (and themself);
 *   everyone else (EMPLOYEE, ADMIN)      -> refused; their own record is `/reports/personal`.
 * Rows are the stored `monthly_summary` totals only. Nothing is recomputed and no absence is derived:
 * `absent` is null and the notice says so, exactly like the personal report (policy-pending).
 */
function createOrganizationReportService({ repositories }) {
  async function build(auth, query, { withUid = false } = {}) {
    const year = Number(query.year);
    const month = Number(query.month);
    assertPeriod(year, month);

    const scope = await resolveScope(auth, repositories, 'data');
    if (!(scope.all || scope.broad)) {
      throw new HttpError(403, 'FORBIDDEN', 'Organization reports need an executive or manager scope; your own report is under /reports/personal');
    }
    const employees = (await repositories.employees.list())
      .filter((employee) => employee.status === undefined || employee.status === 'active')
      .filter((employee) => scope.all || scope.uids.has(employee.employeeUid))
      .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));

    const { start, end } = monthBounds(year, month);
    const recorded = await recordedLeaveByEmployee(repositories, year, month, start, end);
    const coverage = await dataThrough(repositories, start, end, thaiDate);
    const rows = await Promise.all(employees.map(async (employee) => {
      const monthly = await repositories.attendance.findMonthly(employee.employeeUid, year, month);
      return {
        ...(withUid ? { employeeUid: employee.employeeUid } : {}),
        employeeId: employee.employeeId,
        employeeName: `${employee.firstNameTh} ${employee.lastNameTh}`,
        department: employee.department,
        hasMonthlySummary: Boolean(monthly),
        workDays: monthly ? monthly.totalWorkDays : null,
        present: monthly ? monthly.totalPresent : null,
        late: monthly ? monthly.totalLate : null,
        lateMinutes: monthly ? monthly.totalLateMinutes : null,
        leaveDaysOnSummary: monthly ? monthly.totalLeave : null,
        // HIP-recorded leave (not approval). null = month never imported; 0 = covered, none recorded.
        leaveRecordedDays: recorded.covered ? (recorded.byUid.get(employee.employeeUid)?.days ?? 0) : null,
        leaveNeedsReview: recorded.covered ? (recorded.byUid.get(employee.employeeUid)?.needsReview ?? 0) : null,
        absent: null,
      };
    }));

    const withData = rows.filter((row) => row.hasMonthlySummary);
    const sum = (key) => withData.reduce((total, row) => total + Number(row[key] || 0), 0);
    return {
      scope: scope.all ? 'organization' : 'team',
      year,
      month,
      buddhistYear: year + 543,
      periodStart: start,
      periodEnd: end,
      periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`,
      totals: {
        employeesInScope: rows.length,
        employeesWithData: withData.length,
        employeesWithoutData: rows.length - withData.length,
        present: sum('present'),
        late: sum('late'),
        lateMinutes: sum('lateMinutes'),
        leaveDaysOnSummary: sum('leaveDaysOnSummary'),
        leaveRecordedDays: recorded.covered ? rows.reduce((t, r) => t + (r.leaveRecordedDays || 0), 0) : null,
        leaveNeedsReview: recorded.covered ? rows.reduce((t, r) => t + (r.leaveNeedsReview || 0), 0) : null,
        absent: null,
      },
      rows,
      dataThrough: coverage,
      source: 'stored-monthly',
      notices: { holidaysApplied: false, holidayNote: HOLIDAY_NOTE },
    };
  }

  return {
    organization: (auth, query) => build(auth, query),
    /** Same scoped build with employeeUid on each row — for server-side grouping only, never sent to clients. */
    organizationWithUid: (auth, query) => build(auth, query, { withUid: true }),

    async export(auth, query) {
      const format = query.format;
      if (format !== 'pdf' && format !== 'xlsx') {
        throw new HttpError(400, 'EXPORT_INVALID_FORMAT', 'format must be pdf or xlsx');
      }
      const report = await build(auth, query);
      const filename = `attendance-${report.scope}-${report.buddhistYear}-${String(report.month).padStart(2, '0')}.${format}`;
      if (format === 'pdf') {
        return { filename, contentType: 'application/pdf', buffer: await renderOrganizationPdf(report) };
      }
      return {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: writeOrganizationXlsx(report),
      };
    },
  };
}

function writeOrganizationXlsx(report) {
  const notAvailable = 'ไม่มีสรุปรายเดือน';
  return writeXlsx({
    sheets: [
      {
        name: 'สรุป',
        columns: [{ header: 'รายการ', width: 28 }, { header: 'ค่า', width: 44 }],
        rows: [
          ['ขอบเขต', report.scope === 'organization' ? 'ทั้งองค์กร' : 'ทีม'],
          ['ช่วงวันที่', report.periodLabel],
          ['ข้อมูลถึงวันที่', report.dataThrough.through ? report.dataThrough.label.replace('ข้อมูลถึงวันที่ ', '') : 'ไม่มีข้อมูล'],
          ['ปี พ.ศ.', report.buddhistYear],
          ['จำนวนพนักงานในขอบเขต', report.totals.employeesInScope],
          ['มีสรุปรายเดือน', report.totals.employeesWithData],
          ['ไม่มีสรุปรายเดือน', report.totals.employeesWithoutData],
          ['มาทำงาน (รวม)', report.totals.present],
          ['สาย (รวม)', report.totals.late],
          ['นาทีที่สาย (รวม)', report.totals.lateMinutes],
          ['ลา — บันทึกจาก HIP (รวม, วัน)', report.totals.leaveRecordedDays === null ? 'ไม่มีข้อมูล' : report.totals.leaveRecordedDays],
          ['ลา — รอตรวจสอบ (รายการ, ไม่รวมในยอด)', report.totals.leaveNeedsReview === null ? 'ไม่มีข้อมูล' : report.totals.leaveNeedsReview],
          ['หมายเหตุ', report.notices.holidayNote],
        ],
      },
      {
        name: 'รายบุคคล',
        columns: [
          { header: 'รหัสพนักงาน', width: 14 },
          { header: 'ชื่อ-นามสกุล', width: 30 },
          { header: 'วันทำงาน', width: 12 },
          { header: 'มาทำงาน', width: 12 },
          { header: 'สาย', width: 10 },
          { header: 'นาทีที่สาย', width: 12 },
          { header: 'ลา (วัน, บันทึกจาก HIP)', width: 22 },
        ],
        rows: report.rows.map((row) => (row.hasMonthlySummary
          ? [row.employeeId, row.employeeName, row.workDays, row.present, row.late, row.lateMinutes, row.leaveRecordedDays === null ? 'ไม่มีข้อมูล' : row.leaveRecordedDays]
          : [row.employeeId, row.employeeName, notAvailable, '', '', '', ''])),
      },
    ],
  });
}

module.exports = { createOrganizationReportService };
