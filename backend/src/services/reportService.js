const { HttpError } = require('../utils/httpError');
const { writeXlsx } = require('./export/xlsxWriter');
const { renderPersonalPdf } = require('./export/personalPdf');

const THAI_MONTHS = [
  null,
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const STATUS_TH = { late: 'สาย', present: 'มาทำงาน', absent: 'ขาด', leave: 'ลา' };
const LEAVE_TH = { personal: 'ลากิจ' };
const LEAVE_STATUS_TH = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };

function assertPeriod(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'year is invalid');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'month is invalid');
  }
}

function rejectSuppliedIdentity(auth, query) {
  if (query.employeeUid && query.employeeUid !== auth.employeeUid) {
    throw new HttpError(403, 'FORBIDDEN', 'This report is limited to your own record');
  }
  if (query.employeeId) {
    throw new HttpError(403, 'FORBIDDEN', 'This report is limited to your own record');
  }
}

function monthBounds(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function thaiDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${THAI_MONTHS[month]} ${year + 543}`;
}

function bangkokClock(iso) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const shifted = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function labelOrMissing(value, missingLabel) {
  return value || missingLabel;
}

function createReportService({ repositories }) {
  return {
    async personal(auth, query) {
      const year = Number(query.year);
      const month = Number(query.month);
      assertPeriod(year, month);
      rejectSuppliedIdentity(auth, query);
      const employee = await repositories.employees.findByUid(auth.employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      const { start, end } = monthBounds(year, month);
      const monthly = await repositories.attendance.findMonthly(auth.employeeUid, year, month);
      const scans = (await repositories.attendance.findForEmployee(auth.employeeUid))
        .filter((row) => row.date >= start && row.date <= end)
        .map((row) => ({
          date: row.date,
          dateLabel: thaiDate(row.date),
          checkIn: row.checkIn || null,
          checkOut: row.checkOut || null,
          checkInLabel: labelOrMissing(bangkokClock(row.checkIn), 'ไม่มีเวลาเข้า'),
          checkOutLabel: labelOrMissing(bangkokClock(row.checkOut), 'ไม่มีเวลาออก'),
          status: row.status,
          statusLabel: !row.checkIn && row.checkOut ? 'กลับก่อน' : (STATUS_TH[row.status] || row.status),
          lateMinutes: row.lateMinutes ?? null,
        }));
      const leaveRows = (await repositories.leave.list(auth.employeeUid))
        .filter((row) => row.startDate <= end && row.endDate >= start)
        .map((row) => ({
          leaveType: row.leaveType,
          typeLabel: LEAVE_TH[row.leaveType] || row.leaveType,
          startDate: row.startDate,
          endDate: row.endDate,
          startLabel: thaiDate(row.startDate),
          endLabel: thaiDate(row.endDate),
          status: row.status,
          statusLabel: LEAVE_STATUS_TH[row.status] || row.status,
        }));
      const balances = await repositories.leave.balance(auth.employeeUid, year);
      const hasMonthlySummary = Boolean(monthly);
      const empty = !hasMonthlySummary && scans.length === 0 && leaveRows.length === 0;
      return {
        employeeUid: employee.employeeUid,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstNameTh} ${employee.lastNameTh}`,
        department: employee.department,
        position: employee.position,
        year,
        month,
        buddhistYear: year + 543,
        periodStart: start,
        periodEnd: end,
        periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`,
        empty,
        hasMonthlySummary,
        present: hasMonthlySummary ? monthly.totalPresent : null,
        late: hasMonthlySummary ? monthly.totalLate : null,
        absent: hasMonthlySummary ? monthly.totalAbsent : null,
        leaveDaysOnSummary: hasMonthlySummary ? monthly.totalLeave : null,
        workDays: hasMonthlySummary ? monthly.totalWorkDays : null,
        lateMinutes: hasMonthlySummary ? monthly.totalLateMinutes : null,
        scans,
        leaveRows,
        remainingLeaveDays: balances.length
          ? balances.reduce((sum, row) => sum + Number(row.remainingDays || 0), 0)
          : null,
        source: 'stored-monthly-and-leave',
        exclusions: {
          status: 'RESOLVED_BY_OWNER',
          nonMasterCodes: 19,
          nameMismatchEvents: 5,
          acceptedPersonMonthGaps: 24,
        },
      };
    },

    async export(auth, query) {
      const format = query.format;
      if (format !== 'pdf' && format !== 'xlsx') {
        throw new HttpError(400, 'EXPORT_INVALID_FORMAT', 'format must be pdf or xlsx');
      }
      const report = await this.personal(auth, query);
      const filename = `attendance-${report.buddhistYear}-${String(report.month).padStart(2, '0')}.${format}`;
      if (format === 'pdf') {
        return {
          filename,
          contentType: 'application/pdf',
          buffer: await renderPersonalPdf(report),
        };
      }
      return {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: writePersonalXlsx(report),
      };
    },
  };
}

function summaryRows(report) {
  const rows = [
    ['ชื่อ', report.employeeName],
    ['รหัสพนักงาน', report.employeeId],
    ['หน่วยงาน', report.department],
    ['ตำแหน่ง', report.position],
    ['ช่วงวันที่', report.periodLabel],
    ['ปี พ.ศ.', report.buddhistYear],
    ['รหัสนอกมาสเตอร์', 'ไม่นำเข้า 19 รหัส'],
    ['ชื่อไม่ตรง', 'กักกัน 5 แถว'],
    ['คน-เดือนที่ยอดไม่ตรง', 24],
  ];
  if (report.empty) {
    rows.push(['สถานะ', 'ไม่มีข้อมูลการมาทำงานหรือการลาในช่วงนี้']);
    return rows;
  }
  if (report.hasMonthlySummary) {
    rows.push(
      ['วันทำงาน', report.workDays],
      ['มาทำงาน', report.present],
      ['สาย', report.late],
      ['นาทีที่สาย', report.lateMinutes],
      ['ขาด', report.absent],
      ['ลาตามสรุป', report.leaveDaysOnSummary],
    );
  } else {
    rows.push(['สรุปรายเดือน', 'ไม่มีสรุปรายเดือนที่บันทึกไว้']);
  }
  rows.push(['วันลาคงเหลือ', report.remainingLeaveDays == null ? 'ไม่มีวันลาคงเหลือที่บันทึกไว้' : report.remainingLeaveDays]);
  return rows;
}

function writePersonalXlsx(report) {
  const scanRows = report.scans.length
    ? report.scans.map((row) => [row.dateLabel, row.checkInLabel, row.checkOutLabel, row.statusLabel, row.lateMinutes])
    : [['ไม่มีรายการสแกนที่บันทึกไว้', '', '', '', '']];
  const leaveSheetRows = report.leaveRows.length
    ? report.leaveRows.map((row) => [row.typeLabel, row.startLabel, row.endLabel, row.statusLabel])
    : [['ไม่มีรายการลาที่บันทึกไว้', '', '', '']];
  return writeXlsx({
    sheets: [
      {
        name: 'สรุป',
        columns: [{ header: 'รายการ', width: 24 }, { header: 'ค่า', width: 42 }],
        rows: summaryRows(report),
      },
      {
        name: 'การมาทำงาน',
        columns: [
          { header: 'วันที่', width: 24 },
          { header: 'เวลาเข้า', width: 16 },
          { header: 'เวลาออก', width: 16 },
          { header: 'สถานะ', width: 16 },
          { header: 'นาทีที่สาย', width: 14 },
        ],
        rows: report.empty ? [] : scanRows,
      },
      {
        name: 'การลา',
        columns: [
          { header: 'ประเภท', width: 16 },
          { header: 'เริ่ม', width: 24 },
          { header: 'สิ้นสุด', width: 24 },
          { header: 'สถานะ', width: 16 },
        ],
        rows: report.empty ? [] : leaveSheetRows,
      },
    ],
  });
}

module.exports = { createReportService };
