const { DIVISIONS } = require('../config/organization');

const SUM_KEYS = ['present', 'late', 'lateMinutes', 'leaveDaysOnSummary', 'leaveRecordedDays', 'leaveNeedsReview'];

const MEMBERSHIP_NOTE = 'สังกัดกองอ้างอิงตามข้อมูลสังกัดปัจจุบัน (ยังไม่เก็บวันที่มีผลของการย้ายสังกัด) '
  + 'จึงใช้สังกัดเดียวกันกับทุกเดือนที่เลือก';

function round1(value) {
  return Math.round(value * 10) / 10;
}

function summarize(rows) {
  const withData = rows.filter((row) => row.hasMonthlySummary);
  const sum = (key) => withData.reduce((total, row) => total + Number(row[key] || 0), 0);
  return {
    headcount: rows.length,
    withData: withData.length,
    withoutData: rows.length - withData.length,
    present: sum('present'),
    late: sum('late'),
    lateMinutes: sum('lateMinutes'),
    leaveDaysOnSummary: sum('leaveDaysOnSummary'),
    leaveRecordedDays: rows.reduce((total, row) => total + (row.leaveRecordedDays || 0), 0),
    leaveNeedsReview: rows.reduce((total, row) => total + (row.leaveNeedsReview || 0), 0),
    avgPresentPerPerson: withData.length ? round1(sum('present') / withData.length) : null,
  };
}

/**
 * Executive dashboard: the organization month split into the three divisions.
 *
 * Scope is NOT re-implemented here. Rows come from the organization service, which applies
 * resolveScope('data') (EXECUTIVE all / MANAGER granted units / others refused). Division membership is
 * only a grouping over rows the caller is already allowed to see, so it cannot widen access.
 *
 * Reconciliation is part of the payload: every in-scope employee lands in exactly one bucket
 * (a division, `unassigned` = no division membership, or `ambiguous` = more than one), and the bucket
 * sums are compared with the organization totals. Nothing is guessed into a division.
 */
function createDivisionReportService({ repositories, organizationReportService }) {
  return {
    async divisions(auth, query) {
      const org = await organizationReportService.organizationWithUid(auth, query);
      const memberships = await repositories.authorization.listMemberships();
      const known = new Map(DIVISIONS.map((division) => [division.code, division]));
      const codesByUid = new Map();
      for (const { employeeUid, orgUnitCode } of memberships) {
        if (!known.has(orgUnitCode)) continue;
        if (!codesByUid.has(employeeUid)) codesByUid.set(employeeUid, new Set());
        codesByUid.get(employeeUid).add(orgUnitCode);
      }

      const buckets = new Map(DIVISIONS.map((division) => [division.code, []]));
      const unassigned = [];
      const ambiguous = [];
      for (const { employeeUid, ...row } of org.rows) {
        const codes = codesByUid.get(employeeUid);
        if (!codes || codes.size === 0) unassigned.push(row);
        else if (codes.size > 1) ambiguous.push(row);
        else buckets.get([...codes][0]).push(row);
      }

      const isTeam = org.scope !== 'organization';
      const divisions = DIVISIONS
        .map((division) => ({ code: division.code, nameTh: division.nameTh, rows: buckets.get(division.code) }))
        .filter((division) => !isTeam || division.rows.length > 0)
        .map((division) => ({ ...division, ...summarize(division.rows) }));

      const bucketTotals = [...divisions, summarize(unassigned), summarize(ambiguous)];
      const sumOf = (key) => bucketTotals.reduce((total, bucket) => total + bucket[key], 0);
      const headcountSum = sumOf('headcount');
      const reconciled = headcountSum === org.totals.employeesInScope
        && SUM_KEYS.every((key) => sumOf(key) === (org.totals[key] ?? 0));

      return {
        scope: org.scope,
        recordedLeaveCovered: org.totals.leaveRecordedDays !== null,
        dataThrough: org.dataThrough,
        year: org.year,
        month: org.month,
        buddhistYear: org.buddhistYear,
        periodLabel: org.periodLabel,
        totals: org.totals,
        divisions,
        unassigned: { ...summarize(unassigned), rows: unassigned },
        ambiguous: { ...summarize(ambiguous), rows: ambiguous },
        reconciliation: {
          employeesInScope: org.totals.employeesInScope,
          assignedToDivisions: divisions.reduce((total, division) => total + division.headcount, 0),
          unassigned: unassigned.length,
          ambiguous: ambiguous.length,
          reconciled,
        },
        notices: { holidayNote: org.notices.holidayNote, membershipNote: MEMBERSHIP_NOTE },
      };
    },
  };
}

module.exports = { createDivisionReportService };
