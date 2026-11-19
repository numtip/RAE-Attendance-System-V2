const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');

const { assertPeriod, monthBounds, thaiDate } = reportHelpers;

const TYPES = [
  { type: 'personal', labelTh: 'ลากิจ' },
  { type: 'sick', labelTh: 'ลาป่วย' },
  { type: 'vacation', labelTh: 'ลาพักผ่อน' },
];
const TYPE_LABEL = { ...Object.fromEntries(TYPES.map((t) => [t.type, t.labelTh])), other: 'ลาอื่น ๆ' };
const STATUS_LABEL = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };

const DAY_MS = 86400000;
function utcDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Inclusive calendar days of [startDate,endDate] that fall inside [start,end]. */
function overlapDays(startDate, endDate, start, end) {
  const from = Math.max(utcDay(startDate), utcDay(start));
  const to = Math.min(utcDay(endDate), utcDay(end));
  return to < from ? 0 : Math.round((to - from) / DAY_MS) + 1;
}

const NOTICE = 'จำนวนวันนับเป็นวันตามปฏิทินของช่วงที่ลา (ไม่หักเสาร์-อาทิตย์/วันหยุดนักขัตฤกษ์) '
  + 'และตัดเฉพาะส่วนที่อยู่ในเดือนที่เลือก; ระบบยังไม่เก็บการลาครึ่งวัน; นับยอดรวมเฉพาะรายการที่อนุมัติแล้ว';

/**
 * Monthly leave summary (personal / sick / vacation) from employee_leave only.
 * Scope: EXECUTIVE all, MANAGER granted units, anyone else their own row (self-only).
 * Nothing is invented: when the source holds no leave record at all, every employee is reported
 * as "no data" (null), which is different from a counted zero.
 */
function createLeaveMonthlyReportService({ repositories }) {
  return {
    async monthly(auth, query) {
      const year = Number(query.year);
      const month = Number(query.month);
      assertPeriod(year, month);
      const scope = await resolveScope(auth, repositories, 'data');
      const wide = Boolean(scope.all || scope.broad);

      const everyone = (await repositories.employees.list())
        .filter((employee) => employee.status === undefined || employee.status === 'active');
      const employees = everyone
        .filter((employee) => (wide ? (scope.all || scope.uids.has(employee.employeeUid)) : employee.employeeUid === auth.employeeUid))
        .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));
      if (!wide && employees.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');

      const { start, end } = monthBounds(year, month);
      const inScope = new Set(employees.map((employee) => employee.employeeUid));
      const recordsInSystem = await repositories.leave.countAll();
      const overlapping = (await repositories.leave.listOverlapping(start, end))
        .filter((row) => inScope.has(row.employeeUid));

      let unmatched = 0;
      const byUid = new Map();
      for (const row of overlapping) {
        if (row.matchStatus && row.matchStatus !== 'matched') { unmatched += 1; continue; }
        if (!byUid.has(row.employeeUid)) byUid.set(row.employeeUid, []);
        byUid.get(row.employeeUid).push(row);
      }

      const emptyBucket = () => Object.fromEntries(TYPES.map((t) => [t.type, { requests: 0, days: 0 }]));
      const totals = { byType: emptyBucket(), pendingRequests: 0, rejectedRequests: 0, otherApprovedRequests: 0 };

      const rows = employees.map((employee) => {
        const mine = byUid.get(employee.employeeUid) || [];
        const byType = emptyBucket();
        let pending = 0;
        let rejected = 0;
        const details = mine.map((row) => {
          const days = overlapDays(row.startDate, row.endDate, start, end);
          const status = String(row.status || '').toLowerCase();
          if (status === 'approved') {
            if (byType[row.leaveType]) {
              byType[row.leaveType].requests += 1;
              byType[row.leaveType].days += days;
              totals.byType[row.leaveType].requests += 1;
              totals.byType[row.leaveType].days += days;
            } else {
              totals.otherApprovedRequests += 1;
            }
          } else if (status === 'pending') { pending += 1; totals.pendingRequests += 1; }
          else if (status === 'rejected') { rejected += 1; totals.rejectedRequests += 1; }
          return {
            leaveType: row.leaveType,
            typeLabel: TYPE_LABEL[row.leaveType] || row.leaveType,
            startDate: row.startDate,
            endDate: row.endDate,
            startLabel: thaiDate(row.startDate),
            endLabel: thaiDate(row.endDate),
            status,
            statusLabel: STATUS_LABEL[status] || row.status,
            daysInMonth: days,
            crossesMonth: row.startDate < start || row.endDate > end,
            counted: status === 'approved' && Boolean(byType[row.leaveType]),
          };
        }).sort((a, b) => a.startDate.localeCompare(b.startDate));
        const hasData = recordsInSystem > 0;
        return {
          employeeId: employee.employeeId,
          employeeName: `${employee.firstNameTh} ${employee.lastNameTh}`.trim(),
          hasLeaveData: hasData,
          byType: hasData ? byType : null,
          pendingRequests: hasData ? pending : null,
          rejectedRequests: hasData ? rejected : null,
          details,
        };
      });

      return {
        scope: scope.all ? 'organization' : (wide ? 'team' : 'self'),
        year,
        month,
        buddhistYear: year + 543,
        periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`,
        types: TYPES,
        coverage: {
          leaveRecordsInSystem: recordsInSystem,
          hasLeaveData: recordsInSystem > 0,
          unmatchedRecordsExcluded: unmatched,
          note: recordsInSystem > 0 ? null : 'ยังไม่มีข้อมูลการลาในระบบ (ยังไม่ได้นำเข้าจากแหล่งข้อมูลการลา) — ไม่ได้หมายความว่าไม่มีผู้ลา',
        },
        totals: recordsInSystem > 0 ? totals : null,
        rows,
        notices: { dayCounting: NOTICE },
      };
    },
  };
}

module.exports = { createLeaveMonthlyReportService, overlapDays };
