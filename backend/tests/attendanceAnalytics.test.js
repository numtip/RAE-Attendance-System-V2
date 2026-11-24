const assert = require('node:assert/strict');
const test = require('node:test');

const { createAttendanceAnalyticsService, weekdaysBetween } = require('../src/services/attendanceAnalyticsService');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

const employees = [
  { employeeUid: A, employeeId: '1001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', status: 'active' },
  { employeeUid: B, employeeId: '1002', firstNameTh: 'สมหญิง', lastNameTh: 'รักงาน', status: 'active' },
];

const exec = { role: 'executive', employeeUid: 'x' };
const execGrant = [{ employeeUid: 'x', role: 'EXECUTIVE', scopeType: 'organization' }];

/** A stored daily_attendance row; defaults are a plain calculated workday with no exceptions. */
const day = (over = {}) => ({
  employeeUid: A,
  date: '2026-03-02', // Monday
  status: 'present',
  computationStatus: 'calculated',
  dayClassification: 'workday',
  isLate: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  workDuration: 8,
  isLeave: 0,
  ...over,
});

function makeRepos({ dayRows = [], grants = execGrant, members = [], leaveCovered = [], leaveRecords = [], quarantined = null } = {}) {
  const repos = {
    authorization: {
      async grantsFor(uid) { return grants.filter((g) => g.employeeUid === uid); },
      async uidsInOrgUnits(codes) {
        const wanted = Array.isArray(codes) ? codes : [...codes];
        return members.filter((m) => wanted.includes(m.orgUnitCode)).map((m) => m.employeeUid);
      },
      async listMemberships() { return members; },
    },
    employees: { async list() { return employees; } },
    attendance: {
      async listForPeriod(start, end) {
        return dayRows.filter((row) => row.date >= start && row.date <= end);
      },
      async latestDailyDate(start, end) {
        const dates = dayRows.map((row) => row.date).filter((date) => date >= start && date <= end).sort();
        return dates.length ? dates[dates.length - 1] : null;
      },
    },
  };
  if (leaveCovered.length || leaveRecords.length) {
    repos.leaveRecords = {
      async coveredPeriods() { return leaveCovered; },
      async listBetween(start, end) { return leaveRecords.filter((r) => String(r.leaveDate).slice(0, 10) >= start && String(r.leaveDate).slice(0, 10) <= end); },
    };
  }
  if (quarantined !== null) {
    repos.facescanRaw = { async countUnresolvedBetween() { return quarantined; } };
  }
  return repos;
}

const service = (repos) => createAttendanceAnalyticsService({ repositories: repos });
const rowOf = (report, employeeId) => report.rows.find((row) => row.employeeId === employeeId);

test('weekdaysBetween counts Mon–Fri inclusively and clips empty windows to 0', () => {
  assert.equal(weekdaysBetween('2026-03-02', '2026-03-06'), 5); // Mon–Fri
  assert.equal(weekdaysBetween('2026-03-02', '2026-03-08'), 5); // + weekend changes nothing
  assert.equal(weekdaysBetween('2026-03-07', '2026-03-08'), 0); // Sat–Sun
  assert.equal(weekdaysBetween('2026-03-10', '2026-03-05'), 0); // inverted window
  assert.equal(weekdaysBetween('2026-03-02', '2026-03-02'), 1);
});

test('KPIs come only from calculated days; no_data days are missing data, never attendance nor absence', async () => {
  const repos = makeRepos({
    dayRows: [
      day({ employeeUid: A, date: '2026-03-02' }), // Mon, on time
      day({ employeeUid: A, date: '2026-03-03', status: 'late', isLate: 1, lateMinutes: 12 }),
      day({ employeeUid: A, date: '2026-03-04', earlyMinutes: 15 }), // early leave rides on status 'present'
      day({ employeeUid: B, date: '2026-03-02', status: 'pending', computationStatus: 'no_data' }),
      day({ employeeUid: B, date: '2026-03-03', status: 'pending', computationStatus: 'no_data' }),
      day({ employeeUid: B, date: '2026-03-31' }), // data reaches month end: full window in the denominator
    ],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '3' });
  assert.equal(report.totals.workdays, 4);
  assert.equal(report.totals.lateArrivals, 1);
  assert.equal(report.totals.earlyDepartures, 1);
  assert.equal(report.totals.lateMinutes, 12);
  assert.equal(report.totals.noDataDays, 2);
  assert.equal(report.totals.absent, null, 'there is no ABSENT KPI');
  assert.ok(report.coverage.noAbsentNote);
  assert.equal(report.totals.employeesWithRecords, 2, 'rows exist for both employees');
  // March 2026 has 22 weekdays; data present through the 31st → full window in the denominator.
  assert.equal(report.totals.expectedDays, 44);
  assert.equal(report.totals.calculatedDays, 4);
  assert.equal(report.totals.completeness, 4 / 44);
  assert.ok(report.reconciliation.reconciled);
});

test('weekend and holiday rows never inflate KPIs nor the weekday denominator', async () => {
  const repos = makeRepos({
    dayRows: [
      day({ employeeUid: A, date: '2026-03-02' }),
      day({ employeeUid: A, date: '2026-03-07', dayClassification: 'weekend' }), // Saturday scan
      day({ employeeUid: A, date: '2026-03-06', dayClassification: 'holiday', status: 'holiday' }), // data-driven holiday
      day({ employeeUid: A, date: '2026-03-31' }), // data reaches month end
    ],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '3' });
  assert.equal(report.totals.workdays, 2);
  assert.equal(report.totals.expectedDays, 42, '22 weekdays × 2 employees, minus the one recorded holiday for both');
  assert.equal(report.totals.calculatedDays, 2);
});

test('a partial month is clipped out of the denominator and flagged, never read as zero attendance', async () => {
  const repos = makeRepos({
    dayRows: [day({ employeeUid: A, date: '2026-10-01' })], // data stops on Oct 1
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '10' });
  assert.equal(report.dataThrough.through, '2026-10-01');
  assert.equal(report.dataThrough.partial, true);
  assert.ok(report.dataThrough.note);
  // Oct 1 2026 is a Thursday: one covered weekday slot per employee in scope, not the month's 22.
  assert.equal(report.totals.expectedDays, 2);
  assert.equal(report.totals.calculatedDays, 1);
  assert.equal(report.totals.completeness, 1 / 2);
  assert.deepEqual(report.coverage.partialMonths, ['2026-10']);
});

test('a month the source never delivered is null — not zero — and a whole-year view still reconciles', async () => {
  const repos = makeRepos({
    dayRows: [day({ employeeUid: A, date: '2026-01-05' })], // January only
  });
  const report = await service(repos).analytics(exec, { year: '2026' });
  const feb = report.coverage.months.find((m) => m.month === '2026-02');
  assert.equal(feb.covered, false);
  assert.equal(feb.calculatedDays, null);
  assert.equal(feb.completeness, null);
  assert.ok(report.coverage.uncoveredMonths.includes('2026-02'));
  assert.equal(report.coverage.uncoveredMonths.length, 11);
  assert.ok(report.reconciliation.reconciled);
  assert.equal(report.totals.calculatedDays, 1);
});

test('pending_policy days are missing data, not attendance', async () => {
  const repos = makeRepos({
    dayRows: [
      day({ employeeUid: A, date: '2026-01-05' }),
      day({ employeeUid: A, date: '2026-01-06', status: 'pending', computationStatus: 'pending_policy' }),
    ],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '1' });
  assert.equal(report.totals.workdays, 1);
  assert.equal(report.totals.pendingPolicyDays, 1);
  assert.equal(report.totals.absent, null);
});

test('unapproved HIP leave is context only: approved shown, awaiting separated, review/rejected count nothing', async () => {
  const repos = makeRepos({
    dayRows: [day({ employeeUid: A, date: '2026-03-02' }), day({ employeeUid: A, date: '2026-03-31' })],
    leaveCovered: ['2026-03'],
    leaveRecords: [
      { employeeUid: A, leaveDate: '2026-03-05', dayFraction: 1, approvalStatus: 'approved', reviewStatus: 'candidate' },
      { employeeUid: A, leaveDate: '2026-03-06', dayFraction: 0.5, approvalStatus: 'unverified', reviewStatus: 'candidate' },
      { employeeUid: A, leaveDate: '2026-03-09', dayFraction: null, approvalStatus: 'unverified', reviewStatus: 'needs_review' },
      { employeeUid: B, leaveDate: '2026-03-10', dayFraction: 1, approvalStatus: 'rejected', reviewStatus: 'candidate' },
    ],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '3' });
  const a = rowOf(report, '1001');
  assert.equal(a.leaveApprovedDays, 1);
  assert.equal(a.leaveAwaitingDays, 0.5);
  assert.equal(a.leaveNeedsReviewRecords, 1);
  assert.equal(report.totals.leaveApprovedDays, 1);
  assert.equal(report.totals.leaveAwaitingDays, 0.5);
  assert.equal(report.totals.leaveNeedsReviewRecords, 1);
  // Leave context never moves an attendance KPI.
  assert.equal(report.totals.workdays, 2);
  assert.equal(report.totals.expectedDays, 44);
  assert.equal(report.totals.calculatedDays, 2);
});

test('quarantined scans are surfaced as excluded evidence without touching any KPI', async () => {
  const withQuarantine = makeRepos({
    dayRows: [day({ employeeUid: A, date: '2026-03-02' })],
    quarantined: 328,
  });
  const without = makeRepos({ dayRows: [day({ employeeUid: A, date: '2026-03-02' })] });
  const q = await service(withQuarantine).analytics(exec, { year: '2026', month: '3' });
  const base = await service(without).analytics(exec, { year: '2026', month: '3' });
  assert.deepEqual(q.coverage.quarantinedScansExcluded, { count: 328, countedInKpis: false });
  assert.equal(q.totals.workdays, base.totals.workdays);
  assert.equal(q.totals.lateArrivals, base.totals.lateArrivals);
  assert.equal(q.totals.completeness, base.totals.completeness);
  assert.ok(q.coverage.quarantinedNote);
});

test('no data at all: coverage is null (not zero) and every month is uncovered', async () => {
  const report = await service(makeRepos({})).analytics(exec, { year: '2026', month: '3' });
  assert.equal(report.dataThrough.through, null);
  assert.equal(report.totals.completeness, null);
  assert.equal(report.totals.employeesWithRecords, 0);
  assert.equal(report.totals.employeeCoverage.ratio, 0);
  assert.equal(report.coverage.months.every((m) => !m.covered), true);
  assert.ok(report.rows.every((row) => row.hasData === false && row.completeness === null));
});

test('scope: executive sees the organization, a manager only their granted unit, an employee only self', async () => {
  const dayRows = [day({ employeeUid: A, date: '2026-03-02' }), day({ employeeUid: B, date: '2026-03-02' })];
  const org = await service(makeRepos({ dayRows })).analytics(exec, { year: '2026', month: '3' });
  assert.equal(org.scope, 'organization');
  assert.equal(org.rows.length, 2);

  const managerRepos = makeRepos({
    dayRows,
    grants: [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'DIV_OFFICE' }],
    members: [{ employeeUid: A, orgUnitCode: 'DIV_OFFICE' }],
  });
  const team = await service(managerRepos).analytics({ role: 'manager', employeeUid: 'm' }, { year: '2026', month: '3' });
  assert.equal(team.scope, 'team');
  assert.deepEqual(team.rows.map((row) => row.employeeId), ['1001']);
  assert.ok(!JSON.stringify(team).includes('สมหญิง'), 'an out-of-scope person is never leaked');

  const self = await service(makeRepos({ dayRows })).analytics({ role: 'employee', employeeUid: B }, { year: '2026', month: '3' });
  assert.equal(self.scope, 'self');
  assert.deepEqual(self.rows.map((row) => row.employeeId), ['1002']);
});

test('a filter never widens access: an out-of-scope employeeUid is refused with 403', async () => {
  const managerRepos = makeRepos({
    grants: [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'DIV_OFFICE' }],
    members: [{ employeeUid: A, orgUnitCode: 'DIV_OFFICE' }],
  });
  await assert.rejects(
    () => service(managerRepos).analytics({ role: 'manager', employeeUid: 'm' }, { year: '2026', month: '3', employeeUid: B }),
    (e) => e.status === 403,
  );
});

test('invalid periods and filters are rejected', async () => {
  const repos = makeRepos({});
  await assert.rejects(() => service(repos).analytics(exec, { year: '2026', month: '13' }), (e) => e.status === 400);
  await assert.rejects(() => service(repos).analytics(exec, { year: '999' }), (e) => e.status === 400);
  await assert.rejects(() => service(repos).analytics(exec, { year: '2026', month: '3', from: '2026-03-40' }), (e) => e.status === 400);
  await assert.rejects(() => service(repos).analytics(exec, { year: '2026', month: '3', division: 'NOPE' }), (e) => e.status === 400);
  await assert.rejects(() => service(repos).analytics(exec, { year: '2026', month: '3', from: '2026-03-10', to: '2026-03-01' }), (e) => e.status === 400);
});

test('a from/to window clips the analysis to the requested days', async () => {
  const repos = makeRepos({
    dayRows: [
      day({ employeeUid: A, date: '2026-03-02', isLate: 1, lateMinutes: 5, status: 'late' }),
      day({ employeeUid: A, date: '2026-03-05' }),
      day({ employeeUid: A, date: '2026-03-09' }),
    ],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '3', from: '2026-03-04', to: '2026-03-06' });
  assert.equal(report.from, '2026-03-04');
  assert.equal(report.totals.calculatedDays, 1, 'only Mar 5 falls inside the window');
  assert.equal(report.totals.lateArrivals, 0);
  assert.equal(report.totals.expectedDays, 6, 'Mar 4 (Wed), 5 (Thu), 6 (Fri) × 2 employees, full data coverage');
  assert.ok(report.reconciliation.reconciled);
});

test('division buckets aggregate their members and never widen them', async () => {
  const repos = makeRepos({
    dayRows: [
      day({ employeeUid: A, date: '2026-03-02', status: 'late', isLate: 1, lateMinutes: 30 }),
      day({ employeeUid: B, date: '2026-03-02' }),
    ],
    members: [{ employeeUid: A, orgUnitCode: 'DIV_OFFICE' }],
  });
  const report = await service(repos).analytics(exec, { year: '2026', month: '3' });
  const divOffice = report.byDivision.find((d) => d.code === 'DIV_OFFICE');
  assert.equal(divOffice.headcount, 1);
  assert.equal(divOffice.employeesWithRecords, 1);
  assert.equal(divOffice.lateArrivals, 1);
  assert.equal(divOffice.lateMinutes, 30);
  const unassigned = report.byDivision.find((d) => d.code === 'unassigned');
  assert.equal(unassigned.headcount, 1);
  const filtered = await service(repos).analytics(exec, { year: '2026', month: '3', division: 'DIV_OFFICE' });
  assert.deepEqual(filtered.rows.map((row) => row.employeeId), ['1001']);
  assert.ok(filtered.filters.active);
});
