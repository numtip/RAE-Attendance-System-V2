const { HttpError } = require('../utils/httpError');
const { writeXlsx } = require('./export/xlsxWriter');
const { renderLeaveMonthlyPdf } = require('./export/leaveMonthlyPdf');
const { dataThrough } = require('./dataThrough');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');

const { PART_LABEL, REASON_LABEL, APPROVAL_LABEL } = require('./leaveLabels');

const { assertPeriod, monthBounds, thaiDate } = reportHelpers;

const TYPES = [
  { type: 'personal', labelTh: 'ลากิจ' },
  { type: 'sick', labelTh: 'ลาป่วย' },
  { type: 'vacation', labelTh: 'ลาพักผ่อน' },
];
const TYPE_LABEL = { ...Object.fromEntries(TYPES.map((t) => [t.type, t.labelTh])), other: 'ลาอื่น ๆ' };
const STATUS_LABEL = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };

const RECORDED_NOTE = 'ข้อมูลที่บันทึกจากรายงาน HIP (หมายเหตุ) เป็นผลการจัดประเภทจากข้อมูลการสแกน ยอดรวมจึงรวมรายการที่ยังไม่ผ่านการอนุมัติ '
  + '(ส่วนที่ผู้บริหารอนุมัติแล้วแสดงแยก) และไม่ใช้หักวันลาคงเหลือ; ครึ่งวัน = 0.5 วัน (เช้า = มีเวลาออกอย่างเดียว, บ่าย = มีเวลาเข้าอย่างเดียว); '
  + 'รายการที่ขัดแย้งหรือคลุมเครือแยกไว้ให้ตรวจสอบและไม่รวมในยอด';

const RECORDED_COUNTING = 'จำนวนวันที่บันทึกจาก HIP นับตามวันที่มีหมายเหตุลา: เต็มวัน = 1 วัน, ครึ่งวัน = 0.5 วัน; ไม่หักเสาร์-อาทิตย์/วันหยุดนักขัตฤกษ์';

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
    async export(auth, query) {
      const format = query.format;
      if (format !== 'pdf' && format !== 'xlsx') {
        throw new HttpError(400, 'EXPORT_INVALID_FORMAT', 'format must be pdf or xlsx');
      }
      const report = await this.monthly(auth, query);
      const filename = `leave-${report.scope}-${report.buddhistYear}-${String(report.month).padStart(2, '0')}.${format}`;
      if (format === 'pdf') return { filename, contentType: 'application/pdf', buffer: await renderLeaveMonthlyPdf(report) };
      return {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: writeLeaveXlsx(report),
      };
    },

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

      const coverageThrough = await dataThrough(repositories, start, end, thaiDate);
      const periodKey = `${year}-${String(month).padStart(2, '0')}`;
      const covered = (await repositories.leaveRecords.coveredPeriods()).includes(periodKey);
      const recordedRows = covered
        ? (await repositories.leaveRecords.listBetween(start, end)).filter((row) => inScope.has(row.employeeUid))
        : [];
      const emptyRecorded = () => Object.fromEntries(TYPES.map((t) => [t.type, { days: 0, approvedDays: 0, records: 0, fullDays: 0, halfDays: 0 }]));
      const recordedTotals = { byType: emptyRecorded(), needsReviewRecords: 0 };
      const recordedByUid = new Map();
      for (const record of recordedRows) {
        if (!recordedByUid.has(record.employeeUid)) recordedByUid.set(record.employeeUid, []);
        recordedByUid.get(record.employeeUid).push(record);
      }

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
        const myRecorded = (recordedByUid.get(employee.employeeUid) || []).sort((a, b) => a.leaveDate.localeCompare(b.leaveDate));
        const recordedBy = emptyRecorded();
        let needsReview = 0;
        for (const record of myRecorded) {
          if (record.approvalStatus === 'rejected') continue; // a decision, shown in the detail, never counted
          if (record.reviewStatus !== 'candidate') { needsReview += 1; recordedTotals.needsReviewRecords += 1; continue; }
          for (const bucket of [recordedBy[record.leaveType], recordedTotals.byType[record.leaveType]]) {
            bucket.days += Number(record.dayFraction);
            if (record.approvalStatus === 'approved') bucket.approvedDays += Number(record.dayFraction);
            bucket.records += 1;
            if (record.dayPart === 'FULL') bucket.fullDays += 1; else bucket.halfDays += 1;
          }
        }
        return {
          recorded: covered ? recordedBy : null,
          recordedNeedsReview: covered ? needsReview : null,
          recordedDetails: myRecorded.map((record) => ({
            date: record.leaveDate,
            dateLabel: thaiDate(record.leaveDate),
            leaveType: record.leaveType,
            typeLabel: TYPE_LABEL[record.leaveType] || record.leaveType,
            dayPart: record.dayPart,
            partLabel: PART_LABEL[record.dayPart] || record.dayPart,
            dayFraction: record.dayFraction,
            reviewStatus: record.reviewStatus,
            reasonLabels: record.reviewReason ? record.reviewReason.split(',').map((code) => REASON_LABEL[code] || code) : [],
            approvalStatus: record.approvalStatus || 'unverified',
            approvalLabel: APPROVAL_LABEL[record.approvalStatus || 'unverified'],
          })),
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
        dataThrough: coverageThrough,
        recordedCoverage: {
          periodCovered: covered,
          note: covered ? null : 'เดือนนี้ยังไม่มีข้อมูลการลาที่บันทึกจากรายงาน HIP — ไม่ได้หมายความว่าไม่มีผู้ลา',
        },
        recordedTotals: covered ? recordedTotals : null,
        rows,
        notices: { dayCounting: NOTICE, recorded: RECORDED_NOTE, recordedCounting: RECORDED_COUNTING },
      };
    },
  };
}

function writeLeaveXlsx(report) {
  const none = 'ไม่มีข้อมูล';
  const cell = (row, type) => (row.recorded ? row.recorded[type].days : none);
  return writeXlsx({
    sheets: [
      {
        name: 'สรุป',
        columns: [{ header: 'รายการ', width: 30 }, { header: 'ค่า', width: 60 }],
        rows: [
          ['ช่วงวันที่', report.periodLabel],
          ['ข้อมูลถึงวันที่', report.dataThrough.through ? report.dataThrough.label.replace('ข้อมูลถึงวันที่ ', '') : 'ไม่มีข้อมูล'],
          ['ปี พ.ศ.', report.buddhistYear],
          ...report.types.map((t) => [`${t.labelTh} (วัน)`, report.recordedTotals ? report.recordedTotals.byType[t.type].days : none]),
          ['รายการรอตรวจสอบ (ไม่รวมในยอด)', report.recordedTotals ? report.recordedTotals.needsReviewRecords : none],
          ['หมายเหตุ', report.notices.recorded],
          ['การนับวัน', report.notices.dayCounting],
        ],
      },
      {
        name: 'รายบุคคล',
        columns: [
          { header: 'รหัสพนักงาน', width: 14 }, { header: 'ชื่อ-นามสกุล', width: 30 },
          ...report.types.map((t) => ({ header: `${t.labelTh} (วัน)`, width: 16 })),
          { header: 'รอตรวจสอบ (รายการ)', width: 20 },
        ],
        rows: report.rows.map((row) => [
          row.employeeId, row.employeeName, ...report.types.map((t) => cell(row, t.type)),
          row.recordedNeedsReview === null ? none : row.recordedNeedsReview,
        ]),
      },
      {
        name: 'รายการ',
        columns: [
          { header: 'รหัสพนักงาน', width: 14 }, { header: 'ชื่อ-นามสกุล', width: 30 }, { header: 'วันที่', width: 20 },
          { header: 'ประเภท', width: 14 }, { header: 'ช่วงเวลา', width: 16 }, { header: 'จำนวนวัน', width: 12 },
          { header: 'สถานะ', width: 18 }, { header: 'เหตุผลที่ต้องตรวจสอบ', width: 60 },
        ],
        rows: report.rows.flatMap((row) => row.recordedDetails.map((d) => [
          row.employeeId, row.employeeName, d.dateLabel, d.typeLabel, d.partLabel,
          d.dayFraction === null ? '' : d.dayFraction,
          d.reviewStatus === 'candidate' ? 'บันทึกจาก HIP (ยังไม่ยืนยันอนุมัติ)' : 'รอตรวจสอบ',
          d.reasonLabels.join('; '),
        ])),
      },
    ],
  });
}

module.exports = { createLeaveMonthlyReportService, overlapDays };
