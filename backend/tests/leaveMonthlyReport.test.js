const assert = require('node:assert/strict');
const test = require('node:test');

const { createLeaveMonthlyReportService, overlapDays } = require('../src/services/leaveMonthlyReportService');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

const employees = [
  { employeeUid: A, employeeId: '1001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', status: 'active' },
  { employeeUid: B, employeeId: '1002', firstNameTh: 'สมหญิง', lastNameTh: 'รักงาน', status: 'active' },
];

function makeRepos(leaveRows, grants = [], members = []) {
  return {
    authorization: { async grantsFor() { return grants; }, async uidsInOrgUnits() { return members; } },
    employees: { async list() { return employees; } },
    attendance: { async latestDailyDate() { return null; } },
    leaveRecords: { async coveredPeriods() { return []; }, async listBetween() { return []; } },
    leave: {
      async countAll() { return leaveRows.length; },
      async listOverlapping(start, end) { return leaveRows.filter((r) => r.startDate <= end && r.endDate >= start); },
    },
  };
}
const exec = { role: 'executive', employeeUid: 'x' };
const execGrant = [{ employeeUid: 'x', role: 'EXECUTIVE', scopeType: 'organization' }];
const lv = (over) => ({ leaveId: 'L', employeeUid: A, leaveType: 'personal', startDate: '2026-03-02', endDate: '2026-03-03', status: 'approved', matchStatus: 'matched', ...over });

test('overlapDays clips to the month and is inclusive', () => {
  assert.equal(overlapDays('2026-03-30', '2026-04-02', '2026-03-01', '2026-03-31'), 2);
  assert.equal(overlapDays('2026-03-30', '2026-04-02', '2026-04-01', '2026-04-30'), 2);
  assert.equal(overlapDays('2026-03-05', '2026-03-05', '2026-03-01', '2026-03-31'), 1);
  assert.equal(overlapDays('2026-02-01', '2026-02-03', '2026-03-01', '2026-03-31'), 0);
});

test('no leave records in the system is "no data", never zero', async () => {
  const service = createLeaveMonthlyReportService({ repositories: makeRepos([], execGrant) });
  const report = await service.monthly(exec, { year: '2026', month: '3' });
  assert.equal(report.coverage.hasLeaveData, false);
  assert.match(report.coverage.note, /ยังไม่มีข้อมูลการลา/);
  assert.equal(report.totals, null);
  assert.ok(report.rows.every((row) => row.hasLeaveData === false && row.byType === null));
});

test('with leave data present, an employee with none that month is a real zero', async () => {
  const service = createLeaveMonthlyReportService({ repositories: makeRepos([lv({ startDate: '2026-01-05', endDate: '2026-01-05' })], execGrant) });
  const report = await service.monthly(exec, { year: '2026', month: '3' });
  assert.equal(report.coverage.hasLeaveData, true);
  assert.equal(report.rows[0].byType.personal.days, 0);
  assert.equal(report.totals.byType.personal.days, 0);
});

test('counts approved days per type, clips cross-month ranges, keeps pending/rejected out of totals', async () => {
  const service = createLeaveMonthlyReportService({
    repositories: makeRepos([
      lv({ leaveId: '1' }),
      lv({ leaveId: '2', leaveType: 'sick', startDate: '2026-02-27', endDate: '2026-03-02' }),
      lv({ leaveId: '3', leaveType: 'vacation', startDate: '2026-03-30', endDate: '2026-04-02' }),
      lv({ leaveId: '4', status: 'pending', startDate: '2026-03-10', endDate: '2026-03-10' }),
      lv({ leaveId: '5', status: 'rejected', startDate: '2026-03-11', endDate: '2026-03-12' }),
      lv({ leaveId: '6', employeeUid: B, matchStatus: 'unmatched' }),
    ], execGrant),
  });
  const report = await service.monthly(exec, { year: '2026', month: '3' });
  const a = report.rows.find((row) => row.employeeId === '1001');
  assert.deepEqual(a.byType.personal, { requests: 1, days: 2 });
  assert.deepEqual(a.byType.sick, { requests: 1, days: 2 });
  assert.deepEqual(a.byType.vacation, { requests: 1, days: 2 });
  assert.equal(a.pendingRequests, 1);
  assert.equal(a.rejectedRequests, 1);
  assert.equal(report.totals.byType.personal.days, 2);
  assert.equal(report.totals.pendingRequests, 1);
  assert.equal(report.totals.rejectedRequests, 1);
  assert.equal(report.coverage.unmatchedRecordsExcluded, 1);
  assert.ok(a.details.find((d) => d.leaveType === 'sick').crossesMonth);
  assert.equal(a.details.filter((d) => d.counted).length, 3);
  const b = report.rows.find((row) => row.employeeId === '1002');
  assert.equal(b.byType.personal.days, 0, 'an unmatched record is not attributed to anyone');
});

test('an employee sees only their own row; a manager only the granted unit', async () => {
  const repos = makeRepos([lv(), lv({ employeeUid: B })], [], []);
  const self = await createLeaveMonthlyReportService({ repositories: repos }).monthly({ role: 'employee', employeeUid: B }, { year: '2026', month: '3' });
  assert.equal(self.scope, 'self');
  assert.deepEqual(self.rows.map((row) => row.employeeId), ['1002']);

  const managerRepos = makeRepos([lv(), lv({ employeeUid: B })], [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }], [A]);
  const team = await createLeaveMonthlyReportService({ repositories: managerRepos }).monthly({ role: 'manager', employeeUid: 'm' }, { year: '2026', month: '3' });
  assert.equal(team.scope, 'team');
  assert.deepEqual(team.rows.map((row) => row.employeeId), ['1001']);
  assert.ok(!JSON.stringify(team).includes('สมหญิง'));
});

test('invalid period is rejected', async () => {
  const service = createLeaveMonthlyReportService({ repositories: makeRepos([], execGrant) });
  await assert.rejects(() => service.monthly(exec, { year: '2026', month: '13' }), (e) => e.status === 400);
});

// ---- HIP-recorded leave (0.5 / 1.0 day) -------------------------------------------------------
function withRecorded(records, coveredPeriods, grants = execGrant, members = []) {
  const repos = makeRepos([], grants, members);
  repos.leaveRecords = {
    async coveredPeriods() { return coveredPeriods; },
    async listBetween(start, end) { return records.filter((r) => r.leaveDate >= start && r.leaveDate <= end); },
  };
  return repos;
}
const rec = (over) => ({ employeeUid: A, leaveDate: '2026-03-04', leaveType: 'personal', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate', reviewReason: null, approvalStatus: 'unverified', ...over });

test('recorded leave sums 0.5/1.0 days per type, keeps review items out of totals, and stays unverified', async () => {
  const repos = withRecorded([
    rec({}),
    rec({ leaveDate: '2026-03-05', dayPart: 'PM', dayFraction: 0.5 }),
    rec({ leaveDate: '2026-03-06', leaveType: 'sick', dayPart: 'AM', dayFraction: 0.5 }),
    rec({ leaveDate: '2026-03-09', leaveType: 'vacation', dayPart: 'UNKNOWN', dayFraction: null, reviewStatus: 'needs_review', reviewReason: 'both_scans_present' }),
    rec({ employeeUid: B, leaveDate: '2026-03-10', leaveType: 'vacation' }),
  ], ['2026-03']);
  const report = await createLeaveMonthlyReportService({ repositories: repos }).monthly(exec, { year: '2026', month: '3' });
  const a = report.rows.find((r) => r.employeeId === '1001');
  assert.deepEqual(a.recorded.personal, { days: 1.5, approvedDays: 0, awaitingApprovalDays: 1.5, records: 2, fullDays: 1, halfDays: 1 });
  assert.deepEqual(a.recorded.sick, { days: 0.5, approvedDays: 0, awaitingApprovalDays: 0.5, records: 1, fullDays: 0, halfDays: 1 });
  assert.equal(a.recorded.vacation.days, 0, 'the needs_review record is not counted');
  assert.equal(a.recordedNeedsReview, 1);
  assert.equal(report.recordedTotals.byType.vacation.days, 1, 'only the other employee full day counts');
  assert.equal(report.recordedTotals.needsReviewRecords, 1);
  const review = a.recordedDetails.find((d) => d.reviewStatus === 'needs_review');
  assert.equal(review.dayFraction, null);
  assert.ok(review.reasonLabels.length === 1);
  assert.ok(a.recordedDetails.every((d) => d.approvalStatus === 'unverified'));
  assert.match(report.notices.recorded, /ยังไม่ผ่านการอนุมัติ/);
  assert.equal(report.totals, null, 'official approved leave is still "no data", separate from HIP-recorded');
});

test('a month the HIP source never covered is "no data"; a covered month with none is a real zero', async () => {
  const records = [rec({ leaveDate: '2026-03-04' })];
  const uncovered = await createLeaveMonthlyReportService({ repositories: withRecorded(records, ['2026-02']) }).monthly(exec, { year: '2026', month: '3' });
  assert.equal(uncovered.recordedTotals, null);
  assert.ok(uncovered.rows.every((r) => r.recorded === null));
  assert.match(uncovered.recordedCoverage.note, /ไม่ได้หมายความว่าไม่มีผู้ลา/);
  const covered = await createLeaveMonthlyReportService({ repositories: withRecorded([], ['2026-03']) }).monthly(exec, { year: '2026', month: '3' });
  assert.equal(covered.recordedTotals.byType.personal.days, 0);
  assert.equal(covered.rows[0].recorded.personal.days, 0);
});

test('recorded leave respects scope: manager and employee never see out-of-scope rows', async () => {
  const records = [rec({ employeeUid: A }), rec({ employeeUid: B, leaveDate: '2026-03-05' })];
  const mgrGrant = [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }];
  const team = await createLeaveMonthlyReportService({ repositories: withRecorded(records, ['2026-03'], mgrGrant, [A]) })
    .monthly({ role: 'manager', employeeUid: 'm' }, { year: '2026', month: '3' });
  assert.deepEqual(team.rows.map((r) => r.employeeId), ['1001']);
  assert.equal(team.recordedTotals.byType.personal.records, 1);
  const self = await createLeaveMonthlyReportService({ repositories: withRecorded(records, ['2026-03'], []) })
    .monthly({ role: 'employee', employeeUid: B }, { year: '2026', month: '3' });
  assert.deepEqual(self.rows.map((r) => r.employeeId), ['1002']);
  assert.ok(!JSON.stringify(self).includes('สมชาย'));
});

test('exports carry fractional days and no absence wording', async () => {
  const zlib = require('node:zlib');
  const repos = withRecorded([rec({ dayPart: 'PM', dayFraction: 0.5 })], ['2026-03']);
  const service = createLeaveMonthlyReportService({ repositories: repos });
  const x = await service.export(exec, { year: '2026', month: '3', format: 'xlsx' });
  assert.equal(x.buffer.subarray(0, 2).toString(), 'PK');
  const parts = [];
  for (let o = 0; o + 30 < x.buffer.length && x.buffer.readUInt32LE(o) === 0x04034b50;) {
    const nl = x.buffer.readUInt16LE(o + 26), cs = x.buffer.readUInt32LE(o + 18), ds = o + 30 + nl;
    parts.push(zlib.inflateRawSync(x.buffer.subarray(ds, ds + cs)).toString('utf8')); o = ds + cs;
  }
  const xml = parts.join('\n');
  assert.match(xml, /<v>0\.5<\/v>/);
  assert.match(xml, /ครึ่งวันบ่าย/);
  assert.doesNotMatch(xml, /ขาด/);
  const p = await service.export(exec, { year: '2026', month: '3', format: 'pdf' });
  assert.equal(p.buffer.subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(() => service.export(exec, { year: '2026', month: '3', format: 'csv' }), (e) => e.status === 400);
});

// ---- range / filters / status split / divisions -----------------------------------------------
function withDivisions(records, coveredPeriods, memberships) {
  const repos = withRecorded(records, coveredPeriods);
  repos.authorization.listMemberships = async () => memberships;
  return repos;
}
const memberships = [
  { employeeUid: A, orgUnitCode: 'DIV_OFFICE' },
  { employeeUid: B, orgUnitCode: 'DIV_RESEARCH' },
];
const yearRecords = [
  rec({ leaveDate: '2026-01-05' }),
  rec({ leaveDate: '2026-02-05', leaveType: 'sick', approvalStatus: 'approved' }),
  rec({ leaveDate: '2026-02-06', dayPart: 'AM', dayFraction: 0.5, approvalStatus: 'approved' }),
  rec({ employeeUid: B, leaveDate: '2026-02-09', leaveType: 'vacation' }),
  rec({ employeeUid: B, leaveDate: '2026-02-10', dayPart: 'UNKNOWN', dayFraction: null, reviewStatus: 'needs_review', reviewReason: 'both_scans_present' }),
  rec({ employeeUid: B, leaveDate: '2026-02-11', approvalStatus: 'rejected' }),
  rec({ leaveDate: '2026-03-05' }), // March is not covered: never shown or counted
];

test('year view splits recorded / approved / awaiting / needs-review and reconciles with the record list', async () => {
  const repos = withDivisions(yearRecords, ['2026-01', '2026-02'], memberships);
  const report = await createLeaveMonthlyReportService({ repositories: repos }).monthly(exec, { year: '2026' });
  assert.equal(report.month, null);
  assert.deepEqual(report.recordedCoverage.coveredMonths, ['2026-01', '2026-02']);
  assert.equal(report.recordedCoverage.uncoveredMonths.length, 10);
  const all = report.recordedTotals.all;
  assert.equal(all.recordedDays, 3.5);
  assert.equal(all.approvedDays, 1.5);
  assert.equal(all.awaitingApprovalDays, 2);
  assert.equal(all.needsReviewRecords, 1);
  assert.equal(all.rejectedRecords, 1);
  assert.equal(report.records.length, 6, 'the uncovered March record is not shown');
  assert.equal(report.reconciliation.reconciled, true);
  assert.deepEqual(report.records.map((r) => r.status).sort(), ['approved', 'approved', 'needs_review', 'rejected', 'unverified', 'unverified']);
  const office = report.byDivision.find((d) => d.code === 'DIV_OFFICE');
  const research = report.byDivision.find((d) => d.code === 'DIV_RESEARCH');
  assert.equal(office.recordedDays, 2.5);
  assert.equal(research.recordedDays, 1);
  assert.equal(research.needsReviewRecords, 1);
});

test('month, date range, division, employee, status and type filters narrow records and totals', async () => {
  const repos = withDivisions(yearRecords, ['2026-01', '2026-02'], memberships);
  const service = createLeaveMonthlyReportService({ repositories: repos });
  const feb = await service.monthly(exec, { year: '2026', month: '2' });
  assert.equal(feb.records.length, 5);
  const range = await service.monthly(exec, { year: '2026', from: '2026-02-06', to: '2026-02-09' });
  assert.deepEqual(range.records.map((r) => r.date), ['2026-02-06', '2026-02-09']);
  const div = await service.monthly(exec, { year: '2026', division: 'DIV_RESEARCH' });
  assert.deepEqual([...new Set(div.rows.map((r) => r.employeeId))], ['1002']);
  const one = await service.monthly(exec, { year: '2026', employeeUid: A });
  assert.ok(one.records.every((r) => r.employeeUid === A));
  const approved = await service.monthly(exec, { year: '2026', status: 'approved' });
  assert.equal(approved.recordedTotals.all.recordedDays, 1.5);
  assert.equal(approved.recordedTotals.all.awaitingApprovalDays, 0);
  const sick = await service.monthly(exec, { year: '2026', type: 'sick' });
  assert.equal(sick.recordedTotals.all.recordedDays, 1);
  assert.equal(sick.filters.active, true);
});

test('invalid filters are rejected and an out-of-scope employee is forbidden', async () => {
  const repos = withDivisions(yearRecords, ['2026-02'], memberships);
  const service = createLeaveMonthlyReportService({ repositories: repos });
  for (const bad of [{ status: 'x' }, { type: 'x' }, { division: 'x' }, { from: '2026-13-01' }, { from: '2026-05-01', to: '2026-04-01' }]) {
    await assert.rejects(() => service.monthly(exec, { year: '2026', ...bad }), (e) => e.status === 400);
  }
  const self = { role: 'employee', employeeUid: B };
  await assert.rejects(() => service.monthly(self, { year: '2026', employeeUid: A }), (e) => e.status === 403);
  const mine = await service.monthly(self, { year: '2026', employeeUid: B });
  assert.deepEqual([...new Set(mine.records.map((r) => r.employeeId))], ['1002']);
});

test('xlsx and pdf are built from the same report (year view, filtered)', async () => {
  const repos = withDivisions(yearRecords, ['2026-01', '2026-02'], memberships);
  const service = createLeaveMonthlyReportService({ repositories: repos });
  const pdf = await service.export(exec, { year: '2026', status: 'approved', format: 'pdf' });
  assert.equal(pdf.filename, 'leave-organization-2569-all.pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
  const xlsx = await service.export(exec, { year: '2026', format: 'xlsx' });
  assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK');
});
