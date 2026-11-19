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
