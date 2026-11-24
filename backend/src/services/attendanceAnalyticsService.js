const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');
const { dataThrough } = require('./dataThrough');
const { DIVISIONS } = require('../config/organization');

const { HOLIDAY_NOTE, assertPeriod, monthBounds, thaiDate } = reportHelpers;

const DAY_MS = 86400000;

function utcDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Weekdays (Mon–Fri) in the inclusive ISO range — the AR-0001 workday basis, no invented holidays. */
function weekdaysBetween(startIso, endIso) {
  if (endIso < startIso) return 0;
  const from = utcDay(startIso);
  const to = utcDay(endIso);
  let count = 0;
  for (let day = from; day <= to; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}

/**
 * Attendance analytics (organization / department / individual) from stored `daily_attendance` rows.
 *
 * What every KPI counts — and what it must never count:
 *   - Only days the pipeline actually computed (`computation_status = 'calculated'`) carry
 *     attendance KPIs. `no_data` / `insufficient_data` / `pending_policy` / `failed` days are
 *     counted, but as *missing data*, never as attendance — and never as absence (ADR-014:
 *     a missing scan is "no data", not ABSENT).
 *   - The completeness denominator is the weekday-based workday window (Mon–Fri, AR-0001) clipped
 *     month by month to how far the imported data actually reaches. Days the source has not
 *     delivered yet (e.g. a pending HIP export) are OUT of the denominator, so a partial month can
 *     never read as zero attendance. Holidays are subtracted only when the data itself classifies a
 *     day as one — no holiday is invented (`attendance_holiday` is empty, the note stays on screen).
 *   - Unapproved leave periods (HIP-recorded but unverified/rejected/needs_review) are shown as
 *     context and excluded from every calculated KPI. Quarantined scans (`staging_facescan_raw`
 *     unmapped/duplicate) never enter `daily_attendance`; their count is surfaced as evidence.
 *   - Scope is the one data-scope rule (`resolveScope('data')`): EXECUTIVE with an organization
 *     grant sees the organization, MANAGER with org-unit grants their departments, and anyone
 *     else their own record (the individual view). A filter never widens access.
 *
 * Every aggregation is built per month first (clipped to that month's data-through date) and then
 * summed, so the monthly coverage table, the division buckets, the per-person rows and the totals
 * all reconcile to the same days.
 */
function createAttendanceAnalyticsService({ repositories }) {
  function validIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  /** year (required) + optional month (absent = whole year) + optional from/to clipping the range. */
  function resolvePeriod(query) {
    const year = Number(query.year);
    assertPeriod(year, 1);
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
    return { year, month, start, end, months };
  }

  function resolveFilters(query) {
    const filters = { division: null, employeeUid: null };
    if (query.division) {
      if (!DIVISIONS.some((d) => d.code === query.division)) throw new HttpError(400, 'VALIDATION_ERROR', 'division is invalid');
      filters.division = String(query.division);
    }
    if (query.employeeUid) filters.employeeUid = String(query.employeeUid);
    return filters;
  }

  const isoDay = (value) => String(value).slice(0, 10);

  const emptyAgg = () => ({
    expectedDays: 0, calculatedDays: 0, workdays: 0, leaveDays: 0,
    lateArrivals: 0, earlyDepartures: 0, lateMinutes: 0, earlyMinutes: 0,
    noDataDays: 0, pendingPolicyDays: 0, otherDays: 0, missingDays: 0,
  });

  const AGG_KEYS = Object.keys(emptyAgg());

  /** Merge `source` into `target` (numeric fields only; completeness is derived at the end). */
  function mergeAgg(target, source) {
    for (const key of AGG_KEYS) target[key] += source[key];
    return target;
  }

  const withCompleteness = (agg) => ({
    ...agg,
    completeness: agg.expectedDays > 0 ? agg.calculatedDays / agg.expectedDays : null,
  });

  /** Aggregates one set of day rows over [windowStart, windowEnd]. Only calculated rows carry KPIs.
   *  `holidayDates` is the calendar-wide set of days the data itself classifies as a holiday in the
   *  same window — a holiday is subtracted from every employee's denominator, not just the one whose
   *  rows carry the classification. */
  function aggregate(rows, windowStart, windowEnd, holidayDates = new Set()) {
    const totals = emptyAgg();
    for (const row of rows) {
      const isWorkdaySlot = row.dayClassification === 'workday';
      const calculated = row.computationStatus === 'calculated';
      if (calculated) {
        if (isWorkdaySlot) {
          totals.calculatedDays += 1;
          if (row.status === 'present' || row.status === 'late') totals.workdays += 1;
          if (row.status === 'leave') totals.leaveDays += 1;
        }
        totals.lateArrivals += Number(row.isLate) === 1 ? 1 : 0;
        totals.earlyDepartures += Number(row.earlyMinutes) > 0 ? 1 : 0;
        totals.lateMinutes += Number(row.lateMinutes) || 0;
        totals.earlyMinutes += Number(row.earlyMinutes) || 0;
      } else if (isWorkdaySlot) {
        if (row.computationStatus === 'no_data') totals.noDataDays += 1;
        else if (row.computationStatus === 'pending_policy') totals.pendingPolicyDays += 1;
        else totals.otherDays += 1; // insufficient_data / failed — still not attendance, not absence
      }
    }
    // Denominator: weekday slots in the covered window, minus days the data itself marks as a
    // holiday (none exist today — the holiday calendar is not configured — so the note stays shown).
    let holidayCount = 0;
    for (const date of holidayDates) {
      if (date >= windowStart && date <= windowEnd) holidayCount += 1;
    }
    totals.expectedDays = Math.max(0, weekdaysBetween(windowStart, windowEnd) - holidayCount);
    totals.missingDays = Math.max(0, totals.expectedDays - totals.calculatedDays);
    return totals;
  }

  /** HIP-recorded leave by approval state (context only — never an attendance KPI). */
  async function leaveContext(inScope, start, end, months) {
    if (typeof repositories.leaveRecords?.coveredPeriods !== 'function'
      || typeof repositories.leaveRecords?.listBetween !== 'function') {
      return { coveredMonths: [], approvedByUid: new Map(), awaitingByUid: new Map(), needsReviewByUid: new Map() };
    }
    const coveredSet = new Set(await repositories.leaveRecords.coveredPeriods());
    const coveredMonths = months.filter((m) => coveredSet.has(m));
    const approvedByUid = new Map();
    const awaitingByUid = new Map();
    const needsReviewByUid = new Map();
    if (coveredMonths.length > 0) {
      const records = (await repositories.leaveRecords.listBetween(start, end))
        .filter((row) => inScope.has(row.employeeUid) && coveredSet.has(isoDay(row.leaveDate).slice(0, 7)));
      for (const record of records) {
        if (record.reviewStatus === 'needs_review') {
          needsReviewByUid.set(record.employeeUid, (needsReviewByUid.get(record.employeeUid) || 0) + 1);
          continue; // a review item counts nothing — not approved, not awaiting
        }
        if (record.approvalStatus === 'rejected') continue; // a decision, shown by the leave dashboard
        const days = Number(record.dayFraction);
        if (!Number.isFinite(days)) continue; // UNKNOWN part: recorded, carries no day value
        const target = record.approvalStatus === 'approved' ? approvedByUid : awaitingByUid;
        target.set(record.employeeUid, (target.get(record.employeeUid) || 0) + days);
      }
    }
    return { coveredMonths, approvedByUid, awaitingByUid, needsReviewByUid };
  }

  async function analytics(auth, query) {
    const { year, month, start, end, months } = resolvePeriod(query);
    const filters = resolveFilters(query);
    const scope = await resolveScope(auth, repositories, 'data');
    const wide = Boolean(scope.all || scope.broad);

    // Division membership groups rows the caller may already see; it never widens access.
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

    // How far the imported data reaches inside the period (source-level truth, not scope-level).
    const coverageThrough = await dataThrough(repositories, start, end, thaiDate);

    const allDayRows = await repositories.attendance.listForPeriod(start, end);
    const leave = await leaveContext(inScope, start, end, months);

    // ---- per-month aggregation, each month clipped to its own data-through date ----
    const perUidByMonth = new Map(); // monthKey -> Map(uid -> agg)
    const monthStats = [];
    for (const monthKey of months) {
      const monthStart = `${monthKey}-01`;
      const monthEnd = monthBounds(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7))).end;
      const monthThrough = await repositories.attendance.latestDailyDate(monthStart, monthEnd);
      if (!monthThrough) {
        monthStats.push({
          month: monthKey, covered: false, through: null, throughLabel: null, partial: false,
          ...withCompleteness(emptyAgg()),
          expectedDays: null, calculatedDays: null, workdays: null, leaveDays: null,
          lateArrivals: null, earlyDepartures: null, lateMinutes: null, noDataDays: null,
          completeness: null,
        });
        continue;
      }
      const clipStart = monthStart < start ? start : monthStart;
      const clipEnd = [monthEnd, monthThrough, end].sort()[0];
      const byUid = new Map();
      const holidayDates = new Set();
      for (const row of allDayRows) {
        const day = isoDay(row.date);
        if (day < clipStart || day > clipEnd || !inScope.has(row.employeeUid)) continue;
        if (row.dayClassification === 'holiday') holidayDates.add(day);
        if (!byUid.has(row.employeeUid)) byUid.set(row.employeeUid, []);
        byUid.get(row.employeeUid).push(row);
      }
      // Every in-scope employee contributes their weekday slots to this month's denominator, even
      // with zero rows — otherwise an employee with no data would silently shrink the denominator.
      const perUid = new Map();
      const monthTotals = emptyAgg();
      for (const employee of employees) {
        const agg = aggregate(byUid.get(employee.employeeUid) || [], clipStart, clipEnd, holidayDates);
        perUid.set(employee.employeeUid, agg);
        mergeAgg(monthTotals, agg);
      }
      perUidByMonth.set(monthKey, perUid);
      monthStats.push({
        month: monthKey,
        covered: true,
        through: monthThrough,
        throughLabel: `ข้อมูลถึงวันที่ ${thaiDate(monthThrough)}`,
        partial: (utcDay(monthEnd) - utcDay(monthThrough)) / DAY_MS > 3,
        ...withCompleteness(monthTotals),
      });
    }

    // ---- per-employee rows (the individual view), summed across months ----
    const divisionBuckets = new Map();
    const bucketFor = (code) => {
      if (!divisionBuckets.has(code)) {
        divisionBuckets.set(code, {
          code, nameTh: divisionName(code), headcount: 0, employeesWithRecords: 0, ...emptyAgg(),
        });
      }
      return divisionBuckets.get(code);
    };
    const rows = employees.map((employee) => {
      const uid = employee.employeeUid;
      const agg = emptyAgg();
      let hasData = false;
      for (const perUid of perUidByMonth.values()) {
        const part = perUid.get(uid);
        if (part) { mergeAgg(agg, part); hasData = true; }
      }
      const division = divisionOf(uid);
      const bucket = bucketFor(division);
      bucket.headcount += 1;
      if (hasData) bucket.employeesWithRecords += 1;
      mergeAgg(bucket, agg);
      const approvedDays = leave.approvedByUid.get(uid) || 0;
      const awaitingDays = leave.awaitingByUid.get(uid) || 0;
      const needsReview = leave.needsReviewByUid.get(uid) || 0;
      return {
        employeeUid: uid,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstNameTh} ${employee.lastNameTh}`.trim(),
        divisionCode: division,
        divisionName: bucket.nameTh,
        hasData,
        ...withCompleteness(agg),
        leaveApprovedDays: approvedDays,
        leaveAwaitingDays: awaitingDays,
        leaveNeedsReviewRecords: needsReview,
      };
    });

    const order = [...DIVISIONS.map((d) => d.code), 'ambiguous', 'unassigned'];
    const byDivision = order.filter((code) => divisionBuckets.has(code))
      .map((code) => withCompleteness(divisionBuckets.get(code)));

    // ---- totals: summed from the division buckets, so every view reconciles ----
    const employeesWithRecords = rows.filter((row) => row.hasData).length;
    const leaveApprovedDays = rows.reduce((t, r) => t + r.leaveApprovedDays, 0);
    const leaveAwaitingDays = rows.reduce((t, r) => t + r.leaveAwaitingDays, 0);
    const leaveNeedsReviewRecords = rows.reduce((t, r) => t + r.leaveNeedsReviewRecords, 0);
    const totals = byDivision.reduce((acc, bucket) => mergeAgg(acc, bucket), emptyAgg());
    const employeeCoverage = employees.length > 0 ? employeesWithRecords / employees.length : null;
    const reconciliation = {
      daysInTotals: totals.calculatedDays,
      daysInDivisions: byDivision.reduce((t, b) => t + b.calculatedDays, 0),
      daysInRows: rows.reduce((t, r) => t + r.calculatedDays, 0),
      daysInMonths: monthStats.reduce((t, m) => t + (m.calculatedDays || 0), 0),
    };
    reconciliation.reconciled = reconciliation.daysInTotals === reconciliation.daysInDivisions
      && reconciliation.daysInTotals === reconciliation.daysInRows
      && reconciliation.daysInTotals === reconciliation.daysInMonths;

    const quarantinedCount = typeof repositories.facescanRaw?.countUnresolvedBetween === 'function'
      ? await repositories.facescanRaw.countUnresolvedBetween(start, end) : null;

    const periodLabel = month
      ? `${thaiDate(start)} – ${thaiDate(end)}`
      : `ปี พ.ศ. ${year + 543} (${thaiDate(start)} – ${thaiDate(end)})`;
    const uncoveredMonths = months.filter((m) => !monthStats.find((s) => s.month === m)?.covered);
    const partialMonths = monthStats.filter((s) => s.covered && s.partial).map((s) => s.month);
    const anyFilter = Boolean(filters.division || filters.employeeUid);

    return {
      scope: scope.all ? 'organization' : (wide ? 'team' : 'self'),
      year,
      month,
      from: start,
      to: end,
      buddhistYear: year + 543,
      periodLabel,
      filters: { ...filters, divisionName: filters.division ? divisionName(filters.division) : null, active: anyFilter },
      divisions: DIVISIONS.map((d) => ({ code: d.code, nameTh: d.nameTh })),
      dataThrough: coverageThrough,
      coverage: {
        holidayCalendarConfigured: false,
        workdayBasisNote: 'ตัวชี้วัดอ้างอิงวันทำงานวันจันทร์–ศุกร์ตามกฎ AR-0001 เฉพาะช่วงที่มีข้อมูลนำเข้าจริง ระบบยังไม่มีปฏิทินวันหยุดนักขัตฤกษ์ที่กำหนดไว้ จึงไม่หักและไม่สร้างวันหยุดขึ้นเอง',
        noAbsentNote: 'ระบบไม่มีตัวชี้วัดการขาดงาน (ABSENT): วันทำงานที่ไม่มีข้อมูลการสแกนแสดงเป็น “ยังไม่มีข้อมูล” ไม่ใช่การขาดงาน',
        quarantinedNote: 'สแกนที่ระบุตัวตนไม่ได้ (quarantine) ถูกเก็บไว้ครบถ้วนเป็นหลักฐานเดิม แต่ไม่ถูกนำเข้าระบบและไม่นับในตัวชี้วัดใด ๆ',
        leaveApprovalNote: 'วันลาที่บันทึกจาก HIP แสดงแยกตามสถานะอนุมัติ เฉพาะวันที่อนุมัติแล้วจึงอธิบายวันทำงานที่ไม่มีสแกนได้ รายการที่ยังไม่อนุมัติหรือรอตรวจสอบไม่ถูกนับในตัวชี้วัด',
        quarantinedScansExcluded: quarantinedCount === null ? null : { count: quarantinedCount, countedInKpis: false },
        months: monthStats,
        uncoveredMonths,
        partialMonths,
        leaveCoveredMonths: leave.coveredMonths,
      },
      totals: {
        employeesInScope: employees.length,
        employeesWithRecords,
        employeesWithoutRecords: employees.length - employeesWithRecords,
        employeeCoverage: { withRecords: employeesWithRecords, total: employees.length, ratio: employeeCoverage },
        ...withCompleteness(totals),
        leaveApprovedDays,
        leaveAwaitingDays,
        leaveNeedsReviewRecords,
        absent: null, // ADR-014: there is no ABSENT KPI and there never will be from this report
      },
      byDivision,
      rows,
      reconciliation,
      notices: {
        holidayNote: HOLIDAY_NOTE,
        countingBasis: 'นับเฉพาะวันที่ระบบคำนวณแล้ว (calculated) วันที่คำนวณไม่ได้ (ไม่มีสแกน/รอนโยบาย) นับเป็นข้อมูลที่ยังขาด ไม่ใช่การมาหรือไม่มาทำงาน',
        noAbsent: 'ไม่มี KPI การขาดงาน — วันที่ไม่มีข้อมูลสแกนคือ “ยังไม่มีข้อมูล” ไม่ใช่การขาดงาน (ADR-014)',
      },
    };
  }

  return { analytics };
}

module.exports = { createAttendanceAnalyticsService, weekdaysBetween };
