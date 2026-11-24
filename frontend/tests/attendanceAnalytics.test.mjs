import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_DATA, analyticsTrend, completenessLabel, completenessTone, formatLateMinutes,
  matchesSearch, monthLabelTh, topPeopleByLateness, topPeopleByWorkdays, trendMax,
} from '../src/utils/attendanceAnalytics.ts';

// A minimal report shaped exactly like the API returns, for pure-helper tests.
function makeReport(over = {}) {
  return {
    scope: 'organization',
    year: 2026,
    month: null,
    from: '2026-01-01',
    to: '2026-12-31',
    buddhistYear: 2569,
    periodLabel: 'ปี พ.ศ. 2569',
    filters: { division: null, employeeUid: null, divisionName: null, active: false },
    divisions: [],
    dataThrough: { through: '2026-11-18', label: 'ข้อมูลถึงวันที่ 18 พฤศจิกายน 2569', partial: true },
    coverage: {
      holidayCalendarConfigured: false,
      workdayBasisNote: 'x', noAbsentNote: 'x', quarantinedNote: 'x', leaveApprovalNote: 'x',
      quarantinedScansExcluded: { count: 328, countedInKpis: false },
      months: [
        { month: '2026-10', covered: true, through: '2026-10-31', throughLabel: 't', partial: false, expectedDays: 44, calculatedDays: 40, workdays: 38, leaveDays: 2, lateArrivals: 3, earlyDepartures: 1, lateMinutes: 45, noDataDays: 4, completeness: 40 / 44 },
        { month: '2026-11', covered: true, through: '2026-11-18', throughLabel: 't', partial: true, expectedDays: 26, calculatedDays: 20, workdays: 19, leaveDays: 1, lateArrivals: 5, earlyDepartures: 2, lateMinutes: 80, noDataDays: 6, completeness: 20 / 26 },
        { month: '2026-12', covered: false, through: null, throughLabel: null, partial: false, expectedDays: null, calculatedDays: null, workdays: null, leaveDays: null, lateArrivals: null, earlyDepartures: null, lateMinutes: null, noDataDays: null, completeness: null },
      ],
      uncoveredMonths: ['2026-12'],
      partialMonths: ['2026-11'],
      leaveCoveredMonths: ['2026-10', '2026-11'],
    },
    totals: {
      employeesInScope: 2, employeesWithRecords: 2, employeesWithoutRecords: 0,
      employeeCoverage: { withRecords: 2, total: 2, ratio: 1 },
      expectedDays: 70, calculatedDays: 60, workdays: 57, leaveDays: 3,
      lateArrivals: 8, earlyDepartures: 3, lateMinutes: 125, earlyMinutes: 40,
      noDataDays: 10, pendingPolicyDays: 0, otherDays: 0, missingDays: 10,
      completeness: 60 / 70,
      leaveApprovedDays: 2, leaveAwaitingDays: 1, leaveNeedsReviewRecords: 1,
      absent: null,
    },
    byDivision: [],
    rows: [
      { employeeUid: 'u1', employeeId: '1001', employeeName: 'สมชาย ใจดี', divisionCode: 'DIV_OFFICE', divisionName: 'กองบริหาร', hasData: true, expectedDays: 35, calculatedDays: 30, workdays: 29, leaveDays: 1, lateArrivals: 6, earlyDepartures: 2, lateMinutes: 90, earlyMinutes: 25, noDataDays: 5, pendingPolicyDays: 0, missingDays: 5, completeness: 30 / 35, leaveApprovedDays: 1, leaveAwaitingDays: 0.5, leaveNeedsReviewRecords: 1 },
      { employeeUid: 'u2', employeeId: '1002', employeeName: 'สมหญิง รักงาน', divisionCode: 'DIV_OFFICE', divisionName: 'กองบริหาร', hasData: true, expectedDays: 35, calculatedDays: 30, workdays: 28, leaveDays: 2, lateArrivals: 2, earlyDepartures: 1, lateMinutes: 35, earlyMinutes: 15, noDataDays: 5, pendingPolicyDays: 0, missingDays: 5, completeness: 30 / 35, leaveApprovedDays: 1, leaveAwaitingDays: 0.5, leaveNeedsReviewRecords: 0 },
    ],
    reconciliation: { daysInTotals: 60, daysInDivisions: 60, daysInRows: 60, daysInMonths: 60, reconciled: true },
    notices: { holidayNote: 'x', countingBasis: 'x', noAbsent: 'x' },
    ...over,
  };
}

test('completeness labels never fake a percent when there is no denominator', () => {
  assert.equal(completenessLabel(null), NO_DATA);
  assert.equal(completenessLabel(0), '0%');
  assert.equal(completenessLabel(60 / 70), '86%');
  assert.equal(completenessLabel(1), '100%');
  assert.equal(completenessLabel(1.2), '100%', 'clamped');
});

test('completeness tone: healthy from 90%, watch below, muted without data', () => {
  assert.equal(completenessTone(0.95), 'ok');
  assert.equal(completenessTone(0.9), 'ok');
  assert.equal(completenessTone(0.89), 'late');
  assert.equal(completenessTone(0.2), 'late');
  assert.equal(completenessTone(null), 'muted');
});

test('late minutes read naturally: minutes, then hours, zero is a real zero', () => {
  assert.equal(formatLateMinutes(0), '0 นาที');
  assert.equal(formatLateMinutes(45), '45 นาที');
  assert.equal(formatLateMinutes(125), '2 ชม. 5 นาที');
  assert.equal(formatLateMinutes(120), '2 ชม.');
  assert.equal(formatLateMinutes(null), NO_DATA);
});

test('the trend comes from coverage months; uncovered months stay null, partial months are flagged', () => {
  const shortMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const trend = analyticsTrend(makeReport(), shortMonths);
  assert.deepEqual(trend.map((p) => p.label), ['ต.ค.', 'พ.ย.', 'ธ.ค.']);
  assert.equal(trend[0].lateArrivals, 3);
  assert.equal(trend[1].partial, true);
  assert.equal(trend[2].lateArrivals, null, 'December was never imported — null, not 0');
  assert.equal(trend[2].workdays, null);
  assert.equal(trendMax(trend), 5);
});

test('top people charts sort by workdays, and lateness only lists people who were actually late', () => {
  const report = makeReport();
  const byWorkdays = topPeopleByWorkdays(report, 8);
  assert.equal(byWorkdays[0].workdays, 29);
  const byLateness = topPeopleByLateness(report, 8);
  assert.deepEqual(byLateness.map((p) => p.employeeId), ['1001', '1002']);
  const nobody = topPeopleByLateness(makeReport({
    rows: [{ ...report.rows[0], lateArrivals: 0 }],
  }), 8);
  assert.deepEqual(nobody, []);
});

test('the people search matches id or name, case-insensitively, and passes empty queries through', () => {
  const row = { employeeId: '1001', employeeName: 'สมชาย ใจดี' };
  assert.equal(matchesSearch(row, ''), true);
  assert.equal(matchesSearch(row, '1001'), true);
  assert.equal(matchesSearch(row, 'สมชาย'), true);
  assert.equal(matchesSearch(row, '9999'), false);
});

test('coverage months are labelled in Thai with the Buddhist year', () => {
  const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  assert.equal(monthLabelTh('2026-11', months), 'พฤศจิกายน 2569');
  assert.equal(monthLabelTh('2026-01', months), 'มกราคม 2569');
});
