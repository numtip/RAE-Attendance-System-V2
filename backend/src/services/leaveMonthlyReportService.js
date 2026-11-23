const { HttpError } = require('../utils/httpError');
const { writeXlsx } = require('./export/xlsxWriter');
const { renderLeaveMonthlyPdf } = require('./export/leaveMonthlyPdf');
const { dataThrough } = require('./dataThrough');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');
const { DIVISIONS } = require('../config/organization');

const { PART_LABEL, REASON_LABEL, APPROVAL_LABEL } = require('./leaveLabels');

const { assertPeriod, monthBounds, thaiDate } = reportHelpers;

const TYPES = [
  { type: 'personal', labelTh: 'ลากิจ' },
  { type: 'sick', labelTh: 'ลาป่วย' },
  { type: 'vacation', labelTh: 'ลาพักผ่อน' },
];
const TYPE_LABEL = { ...Object.fromEntries(TYPES.map((t) => [t.type, t.labelTh])), other: 'ลาอื่น ๆ' };
const STATUS_LABEL = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };
/**
 * Explicit status of one HIP-recorded day. It is derived only from stored columns:
 *   rejected     approval_status = rejected (a decision; never counted)
 *   needs_review review_status = needs_review (conflicting/ambiguous; never counted)
 *   approved     candidate + approval_status = approved (executive decided)
 *   unverified   candidate + not yet decided (counted as recorded, not as approved)
 */
const RECORD_STATUS_LABEL = {
  approved: 'อนุมัติแล้ว',
  unverified: 'บันทึกจาก HIP · รออนุมัติ',
  needs_review: 'รอตรวจสอบ',
  rejected: 'ไม่อนุมัติ',
};
const RECORD_STATUSES = Object.keys(RECORD_STATUS_LABEL);
const SOURCE_LABEL = { hip_daily_report_remark: 'รายงาน HIP (หมายเหตุ)', owner_manual_entry: 'บันทึกด้วยมือ' };
const LEGACY_STATUS_FOR = { approved: 'approved', unverified: 'pending', rejected: 'rejected' };

function recordStatus(record) {
  if (record.approvalStatus === 'rejected') return 'rejected';
  if (record.reviewStatus !== 'candidate') return 'needs_review';
  return record.approvalStatus === 'approved' ? 'approved' : 'unverified';
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** year (required) + optional month (absent = whole year) + optional from/to clipping the range. */
function resolvePeriod(query) {
  const year = Number(query.year);
  reportHelpers.assertPeriod(year, 1);
  const hasMonth = query.month !== undefined && query.month !== null && query.month !== '' && query.month !== 'all';
  const month = hasMonth ? Number(query.month) : null;
  if (hasMonth) assertPeriod(year, month);
  const bounds = hasMonth ? monthBounds(year, month) : { start: `${year}-01-01`, end: `${year}-12-31` };
  let { start, end } = bounds;
  for (const key of ['from', 'to']) {
    if (query[key] && !validIsoDate(String(query[key]))) throw new HttpError(400, 'VALIDATION_ERROR', `${key} is invalid`);
  }
  if (query.from && String(query.from) > start) start = String(query.from);
  if (query.to && String(query.to) < end) end = String(query.to);
  if (start > end) throw new HttpError(400, 'VALIDATION_ERROR', 'date range is empty');
  const months = [];
  for (let m = Number(start.slice(5, 7)), y = Number(start.slice(0, 4)); `${y}-${String(m).padStart(2, '0')}` <= end.slice(0, 7);) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return { year, month, start, end, months, clipped: start !== bounds.start || end !== bounds.end };
}

function resolveFilters(query) {
  const filters = { division: null, employeeUid: null, status: null, type: null };
  if (query.division) {
    if (!DIVISIONS.some((d) => d.code === query.division)) throw new HttpError(400, 'VALIDATION_ERROR', 'division is invalid');
    filters.division = String(query.division);
  }
  if (query.status) {
    if (!RECORD_STATUSES.includes(query.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'status is invalid');
    filters.status = String(query.status);
  }
  if (query.type) {
    if (!TYPES.some((t) => t.type === query.type)) throw new HttpError(400, 'VALIDATION_ERROR', 'type is invalid');
    filters.type = String(query.type);
  }
  if (query.employeeUid) filters.employeeUid = String(query.employeeUid);
  return filters;
}

const emptyDayTotals = () => ({ records: 0, recordedDays: 0, approvedDays: 0, awaitingApprovalDays: 0, needsReviewRecords: 0, rejectedRecords: 0 });
function addToDayTotals(target, record, status) {
  target.records += 1;
  if (status === 'needs_review') { target.needsReviewRecords += 1; return; }
  if (status === 'rejected') { target.rejectedRecords += 1; return; }
  const days = Number(record.dayFraction);
  target.recordedDays += days;
  if (status === 'approved') target.approvedDays += days; else target.awaitingApprovalDays += days;
}

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
      const period = report.month ? String(report.month).padStart(2, '0') : 'all';
      const filename = `leave-${report.scope}-${report.buddhistYear}-${period}.${format}`;
      if (format === 'pdf') return { filename, contentType: 'application/pdf', buffer: await renderLeaveMonthlyPdf(report) };
      return {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: writeLeaveXlsx(report),
      };
    },

    async monthly(auth, query) {
      const { year, month, start, end, months, clipped } = resolvePeriod(query);
      const filters = resolveFilters(query);
      const scope = await resolveScope(auth, repositories, 'data');
      const wide = Boolean(scope.all || scope.broad);

      // Division membership (org units) groups rows the caller may already see; it never widens access.
      const memberships = typeof repositories.authorization.listMemberships === 'function'
        ? await repositories.authorization.listMemberships() : [];
      const divisionCodes = new Map();
      for (const { employeeUid, orgUnitCode } of memberships) {
        if (!DIVISIONS.some((d) => d.code === orgUnitCode)) continue;
        if (!divisionCodes.has(employeeUid)) divisionCodes.set(employeeUid, new Set());
        divisionCodes.get(employeeUid).add(orgUnitCode);
      }
      const divisionOf = (uid) => {
        const codes = divisionCodes.get(uid);
        if (!codes || codes.size === 0) return 'unassigned';
        return codes.size > 1 ? 'ambiguous' : [...codes][0];
      };
      const divisionName = (code) => (DIVISIONS.find((d) => d.code === code) || {}).nameTh
        || (code === 'ambiguous' ? 'สังกัดมากกว่าหนึ่งกอง' : 'ไม่ระบุสังกัดกอง');

      const everyone = (await repositories.employees.list())
        .filter((employee) => employee.status === undefined || employee.status === 'active');
      let employees = everyone
        .filter((employee) => (wide ? (scope.all || scope.uids.has(employee.employeeUid)) : employee.employeeUid === auth.employeeUid))
        .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));
      if (!wide && employees.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      if (filters.employeeUid) {
        // An employee outside the caller's scope is refused, never silently widened or emptied.
        if (!employees.some((employee) => employee.employeeUid === filters.employeeUid)) {
          throw new HttpError(403, 'FORBIDDEN', 'This employee is outside your scope');
        }
        employees = employees.filter((employee) => employee.employeeUid === filters.employeeUid);
      }
      if (filters.division) employees = employees.filter((employee) => divisionOf(employee.employeeUid) === filters.division);

      const inScope = new Set(employees.map((employee) => employee.employeeUid));
      const recordsInSystem = await repositories.leave.countAll();
      const legacyStatus = filters.status ? LEGACY_STATUS_FOR[filters.status] : null;
      const overlapping = (await repositories.leave.listOverlapping(start, end))
        .filter((row) => inScope.has(row.employeeUid))
        .filter((row) => !filters.type || row.leaveType === filters.type)
        .filter((row) => !filters.status || (legacyStatus && String(row.status || '').toLowerCase() === legacyStatus));

      const coverageThrough = await dataThrough(repositories, start, end, thaiDate);
      const coveredSet = new Set(await repositories.leaveRecords.coveredPeriods());
      const coveredMonths = months.filter((m) => coveredSet.has(m));
      const uncoveredMonths = months.filter((m) => !coveredSet.has(m));
      // A month that was never imported is "no data" (null), not zero: its records are not shown or counted.
      const covered = coveredMonths.length > 0;
      const scopedRecords = covered
        ? (await repositories.leaveRecords.listBetween(start, end))
          .filter((row) => inScope.has(row.employeeUid) && coveredSet.has(String(row.leaveDate).slice(0, 7)))
        : [];
      const recordedRows = scopedRecords
        .map((record) => ({ record, status: recordStatus(record) }))
        .filter(({ record, status }) => (!filters.status || status === filters.status) && (!filters.type || record.leaveType === filters.type));

      const emptyRecorded = () => Object.fromEntries(TYPES.map((t) => [t.type, { days: 0, approvedDays: 0, awaitingApprovalDays: 0, records: 0, fullDays: 0, halfDays: 0 }]));
      const recordedTotals = { byType: emptyRecorded(), needsReviewRecords: 0, all: emptyDayTotals() };
      const recordedByUid = new Map();
      for (const entry of recordedRows) {
        if (!recordedByUid.has(entry.record.employeeUid)) recordedByUid.set(entry.record.employeeUid, []);
        recordedByUid.get(entry.record.employeeUid).push(entry);
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
      const divisionBuckets = new Map();
      const bucketFor = (code) => {
        if (!divisionBuckets.has(code)) {
          divisionBuckets.set(code, {
            code, nameTh: divisionName(code), headcount: 0, employeesWithRecords: 0,
            byType: emptyRecorded(), ...emptyDayTotals(),
          });
        }
        return divisionBuckets.get(code);
      };
      const records = [];

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
        const myRecorded = (recordedByUid.get(employee.employeeUid) || []).sort((a, b) => a.record.leaveDate.localeCompare(b.record.leaveDate));
        const recordedBy = emptyRecorded();
        const mineTotals = emptyDayTotals();
        const division = divisionOf(employee.employeeUid);
        const bucket = bucketFor(division);
        bucket.headcount += 1;
        if (myRecorded.length) bucket.employeesWithRecords += 1;
        const employeeName = `${employee.firstNameTh} ${employee.lastNameTh}`.trim();
        for (const { record, status } of myRecorded) {
          for (const target of [mineTotals, recordedTotals.all, bucket]) addToDayTotals(target, record, status);
          records.push({
            employeeUid: employee.employeeUid,
            employeeId: employee.employeeId,
            employeeName,
            divisionCode: division,
            divisionName: bucket.nameTh,
            date: record.leaveDate,
            dateLabel: thaiDate(record.leaveDate),
            leaveType: record.leaveType,
            typeLabel: TYPE_LABEL[record.leaveType] || record.leaveType,
            dayPart: record.dayPart,
            partLabel: PART_LABEL[record.dayPart] || record.dayPart,
            dayFraction: record.dayFraction,
            status,
            statusLabel: RECORD_STATUS_LABEL[status],
            reasonLabels: record.reviewReason ? record.reviewReason.split(',').map((code) => REASON_LABEL[code] || code) : [],
            sourceLabel: SOURCE_LABEL[record.sourceSystem] || record.sourceSystem || null,
          });
          if (status === 'rejected') continue; // a decision, shown in the detail, never counted
          if (status === 'needs_review') { recordedTotals.needsReviewRecords += 1; continue; }
          for (const target of [recordedBy[record.leaveType], recordedTotals.byType[record.leaveType], bucket.byType[record.leaveType]]) {
            target.days += Number(record.dayFraction);
            if (status === 'approved') target.approvedDays += Number(record.dayFraction);
            else target.awaitingApprovalDays += Number(record.dayFraction);
            target.records += 1;
            if (record.dayPart === 'FULL') target.fullDays += 1; else target.halfDays += 1;
          }
        }
        return {
          employeeUid: employee.employeeUid,
          divisionCode: division,
          divisionName: bucket.nameTh,
          recorded: covered ? recordedBy : null,
          recordedNeedsReview: covered ? mineTotals.needsReviewRecords : null,
          recordedTotals: covered ? mineTotals : null,
          recordedDetails: myRecorded.map(({ record, status }) => ({
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
            status,
            statusLabel: RECORD_STATUS_LABEL[status],
          })),
          employeeId: employee.employeeId,
          employeeName,
          hasLeaveData: hasData,
          byType: hasData ? byType : null,
          pendingRequests: hasData ? pending : null,
          rejectedRequests: hasData ? rejected : null,
          details,
        };
      });
      records.sort((a, b) => a.date.localeCompare(b.date) || String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));

      const order = [...DIVISIONS.map((d) => d.code), 'ambiguous', 'unassigned'];
      const byDivision = order.filter((code) => divisionBuckets.has(code)).map((code) => divisionBuckets.get(code));
      const sumDays = (key) => byDivision.reduce((total, b) => total + b[key], 0);
      const reconciliation = {
        recordsMatched: recordedRows.length,
        recordsInRows: rows.reduce((total, row) => total + row.recordedDetails.length, 0),
        recordsInList: records.length,
        recordsInDivisions: sumDays('records'),
        recordedDaysInDivisions: sumDays('recordedDays'),
        recordedDaysInTotals: recordedTotals.all.recordedDays,
      };
      reconciliation.reconciled = reconciliation.recordsMatched === reconciliation.recordsInRows
        && reconciliation.recordsMatched === reconciliation.recordsInList
        && reconciliation.recordsMatched === reconciliation.recordsInDivisions
        && reconciliation.recordedDaysInDivisions === reconciliation.recordedDaysInTotals;

      const periodLabel = month || clipped
        ? `${thaiDate(start)} – ${thaiDate(end)}`
        : `ปี พ.ศ. ${year + 543} (${thaiDate(start)} – ${thaiDate(end)})`;
      const anyFilter = Object.values(filters).some(Boolean);
      const periodNote = covered && uncoveredMonths.length > 0 && coveredMonths.length > 0
        ? `บางเดือนในช่วงนี้ยังไม่มีข้อมูลการลาที่บันทึกจาก HIP (${uncoveredMonths.length} เดือน) — ไม่ได้หมายความว่าไม่มีผู้ลา`
        : null;

      return {
        scope: scope.all ? 'organization' : (wide ? 'team' : 'self'),
        year,
        month,
        from: start,
        to: end,
        buddhistYear: year + 543,
        periodLabel,
        types: TYPES,
        filters: {
          ...filters,
          divisionName: filters.division ? divisionName(filters.division) : null,
          statusLabel: filters.status ? RECORD_STATUS_LABEL[filters.status] : null,
          typeLabel: filters.type ? TYPE_LABEL[filters.type] : null,
          active: anyFilter || clipped,
        },
        divisions: DIVISIONS.map((d) => ({ code: d.code, nameTh: d.nameTh })),
        statuses: RECORD_STATUSES.map((code) => ({ code, label: RECORD_STATUS_LABEL[code] })),
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
          coveredMonths,
          uncoveredMonths,
          note: covered ? periodNote : 'ช่วงเวลานี้ยังไม่มีข้อมูลการลาที่บันทึกจากรายงาน HIP — ไม่ได้หมายความว่าไม่มีผู้ลา',
        },
        recordedTotals: covered ? recordedTotals : null,
        byDivision: covered ? byDivision : null,
        records: covered ? records : [],
        reconciliation,
        rows,
        notices: { dayCounting: NOTICE, recorded: RECORDED_NOTE, recordedCounting: RECORDED_COUNTING },
      };
    },
  };
}

function writeLeaveXlsx(report) {
  const none = 'ไม่มีข้อมูล';
  const t = report.recordedTotals;
  const cell = (row, type) => (row.recorded ? row.recorded[type].days : none);
  const filterText = [
    report.filters.divisionName && `กอง: ${report.filters.divisionName}`,
    report.filters.typeLabel && `ประเภท: ${report.filters.typeLabel}`,
    report.filters.statusLabel && `สถานะ: ${report.filters.statusLabel}`,
    report.filters.employeeUid && 'เฉพาะพนักงานที่เลือก',
  ].filter(Boolean).join(' · ') || 'ไม่มี (แสดงทุกรายการในขอบเขตสิทธิ์)';
  return writeXlsx({
    sheets: [
      {
        name: 'สรุป',
        columns: [{ header: 'รายการ', width: 34 }, { header: 'ค่า', width: 60 }],
        rows: [
          ['ช่วงวันที่', report.periodLabel],
          ['ตัวกรอง', filterText],
          ['ข้อมูลถึงวันที่', report.dataThrough.through ? report.dataThrough.label.replace('ข้อมูลถึงวันที่ ', '') : 'ไม่มีข้อมูล'],
          ['ปี พ.ศ.', report.buddhistYear],
          ...report.types.map((ty) => [`${ty.labelTh} — บันทึกจาก HIP (วัน)`, t ? t.byType[ty.type].days : none]),
          ['รวมบันทึกจาก HIP (วัน)', t ? t.all.recordedDays : none],
          ['  ในจำนวนนี้ อนุมัติแล้ว (วัน)', t ? t.all.approvedDays : none],
          ['  ในจำนวนนี้ รออนุมัติ (วัน)', t ? t.all.awaitingApprovalDays : none],
          ['รอตรวจสอบ (รายการ, ไม่รวมในยอด)', t ? t.all.needsReviewRecords : none],
          ['ไม่อนุมัติ (รายการ, ไม่รวมในยอด)', t ? t.all.rejectedRecords : none],
          ['หมายเหตุ', report.notices.recorded],
          ['การนับวัน', report.notices.recordedCounting],
        ],
      },
      {
        name: 'รายกอง',
        columns: [
          { header: 'กอง', width: 34 }, { header: 'จำนวนคน', width: 12 },
          ...report.types.map((ty) => ({ header: `${ty.labelTh} (วัน)`, width: 16 })),
          { header: 'รวมบันทึก (วัน)', width: 16 }, { header: 'อนุมัติแล้ว (วัน)', width: 16 },
          { header: 'รออนุมัติ (วัน)', width: 16 }, { header: 'รอตรวจสอบ (รายการ)', width: 20 },
        ],
        rows: (report.byDivision || []).map((b) => [
          b.nameTh, b.headcount, ...report.types.map((ty) => b.byType[ty.type].days),
          b.recordedDays, b.approvedDays, b.awaitingApprovalDays, b.needsReviewRecords,
        ]),
      },
      {
        name: 'รายบุคคล',
        columns: [
          { header: 'รหัสพนักงาน', width: 14 }, { header: 'ชื่อ-นามสกุล', width: 30 }, { header: 'กอง', width: 30 },
          ...report.types.map((ty) => ({ header: `${ty.labelTh} (วัน)`, width: 16 })),
          { header: 'รวมบันทึก (วัน)', width: 16 }, { header: 'อนุมัติแล้ว (วัน)', width: 16 },
          { header: 'รออนุมัติ (วัน)', width: 16 }, { header: 'รอตรวจสอบ (รายการ)', width: 20 },
        ],
        rows: report.rows.map((row) => [
          row.employeeId, row.employeeName, row.divisionName, ...report.types.map((ty) => cell(row, ty.type)),
          row.recordedTotals ? row.recordedTotals.recordedDays : none,
          row.recordedTotals ? row.recordedTotals.approvedDays : none,
          row.recordedTotals ? row.recordedTotals.awaitingApprovalDays : none,
          row.recordedNeedsReview === null ? none : row.recordedNeedsReview,
        ]),
      },
      {
        name: 'รายการ',
        columns: [
          { header: 'รหัสพนักงาน', width: 14 }, { header: 'ชื่อ-นามสกุล', width: 30 }, { header: 'กอง', width: 30 },
          { header: 'วันที่', width: 20 }, { header: 'ประเภท', width: 14 }, { header: 'ช่วงเวลา', width: 16 },
          { header: 'จำนวนวัน', width: 12 }, { header: 'สถานะ', width: 26 }, { header: 'แหล่งข้อมูล', width: 24 },
          { header: 'เหตุผลที่ต้องตรวจสอบ', width: 60 },
        ],
        rows: report.records.map((d) => [
          d.employeeId, d.employeeName, d.divisionName, d.dateLabel, d.typeLabel, d.partLabel,
          d.dayFraction === null ? '' : d.dayFraction, d.statusLabel, d.sourceLabel || '', d.reasonLabels.join('; '),
        ]),
      },
    ],
  });
}

module.exports = { createLeaveMonthlyReportService, overlapDays };
