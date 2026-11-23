const assert = require('node:assert/strict');
const test = require('node:test');

const { createLeaveService } = require('../src/services/leaveService');

const ME = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeRepos({ records = [], legacy = [], balances = [] } = {}) {
  return {
    authorization: { async grantsFor() { return []; }, async uidsInOrgUnits() { return []; } },
    employees: { async findByUid(uid) { return { employeeUid: uid }; } },
    leave: {
      async list(uid) { return legacy.filter((r) => r.employeeUid === uid); },
      async balance(uid, year) { return balances.filter((r) => r.employeeUid === uid && r.year === year); },
    },
    leaveRecords: { async listForEmployee(uid) { return records.filter((r) => r.employeeUid === uid); } },
  };
}
const me = { role: 'user', employeeUid: ME };
const rec = (over) => ({
  recordUid: `R-${Math.random()}`, employeeUid: ME, leaveDate: '2026-03-04', leaveType: 'personal', dayPart: 'FULL', dayFraction: 1,
  reviewStatus: 'candidate', reviewReason: null, approvalStatus: 'unverified', sourceSystem: 'hip_daily_report_remark', ...over,
});

test('list shows HIP and manual records with their real approval status, newest first', async () => {
  const service = createLeaveService({ repositories: makeRepos({ records: [
    rec({ leaveDate: '2026-03-04' }),
    rec({ leaveDate: '2026-03-05', approvalStatus: 'approved', sourceSystem: 'owner_manual_entry' }),
    rec({ leaveDate: '2026-03-06', reviewStatus: 'needs_review', reviewReason: 'both_scans_present', dayPart: 'UNKNOWN', dayFraction: null }),
    rec({ leaveDate: '2026-03-07', approvalStatus: 'rejected' }),
  ] }) });
  const list = await service.list(me, undefined, {});
  assert.deepEqual(list.map((r) => r.status), ['rejected', 'needs_review', 'approved', 'unverified']);
  assert.deepEqual(list.map((r) => r.source), ['hip', 'hip', 'manual', 'hip']);
  assert.equal(list[1].dayFraction, null);
  assert.equal(list[1].reasonLabels.length, 1);
  assert.ok(list.every((r) => r.statusLabel));
  assert.equal(list.find((r) => r.status === 'unverified').statusLabel.includes('อนุมัติแล้ว'), false, 'an undecided record is never shown as approved');
});

test('year filter, validation and a legacy row fully covered by records is not listed twice', async () => {
  const service = createLeaveService({ repositories: makeRepos({
    records: [rec({ leaveDate: '2026-03-04' }), rec({ leaveDate: '2025-12-30' })],
    legacy: [
      { leaveId: 'L1', employeeUid: ME, leaveType: 'personal', startDate: '2026-03-04', endDate: '2026-03-04', status: 'approved', matchStatus: 'matched' },
      { leaveId: 'L2', employeeUid: ME, leaveType: 'sick', startDate: '2026-03-10', endDate: '2026-03-11', status: 'pending', matchStatus: 'matched' },
    ],
  }) });
  const all = await service.history(me, ME);
  assert.deepEqual(all.map((r) => r.leaveId).filter((id) => id.startsWith('L')), ['L2']);
  assert.equal(all.length, 3);
  assert.equal(all.find((r) => r.leaveId === 'L2').statusLabel, 'รออนุมัติ');
  const y2026 = await service.list(me, undefined, { year: '2026' });
  assert.equal(y2026.length, 2);
  await assert.rejects(() => service.list(me, undefined, { year: 'abc' }), (e) => e.status === 400);
});

test('access: an employee cannot read someone else\'s list, history or balance', async () => {
  const service = createLeaveService({ repositories: makeRepos({ records: [rec({ employeeUid: OTHER })] }) });
  await assert.rejects(() => service.list(me, OTHER, {}), (e) => e.status === 403);
  await assert.rejects(() => service.history(me, OTHER), (e) => e.status === 403);
  await assert.rejects(() => service.balance(me, OTHER, 2026), (e) => e.status === 403);
  assert.equal((await service.list(me, undefined, {})).length, 0, 'own list never includes another employee');
});

test('balance without an entitlement is unavailable (null), never zero', async () => {
  const service = createLeaveService({ repositories: makeRepos({ records: [rec({ approvalStatus: 'approved' })] }) });
  const rows = await service.balance(me, ME, 2026);
  assert.deepEqual(rows.map((r) => r.leaveType), ['personal', 'sick', 'vacation']);
  for (const row of rows) {
    assert.equal(row.totalDays, null);
    assert.equal(row.remainingDays, null);
    assert.equal(row.available, false);
    assert.equal(row.unavailableReason, 'no_entitlement');
  }
  assert.equal(rows[0].usedDays, 1, 'approved days are still reported');
});

test('balance deducts only approved days, once per calendar day', async () => {
  const service = createLeaveService({ repositories: makeRepos({
    balances: [{ employeeUid: ME, year: 2026, leaveType: 'personal', totalDays: 6, usedDays: 99, remainingDays: 0 }],
    records: [
      rec({ leaveDate: '2026-03-04', approvalStatus: 'approved' }),
      rec({ leaveDate: '2026-03-05', approvalStatus: 'approved', dayPart: 'AM', dayFraction: 0.5 }),
      rec({ leaveDate: '2026-03-06' }), // recorded, undecided
      rec({ leaveDate: '2026-03-09', reviewStatus: 'needs_review', dayFraction: null }),
      rec({ leaveDate: '2026-03-10', approvalStatus: 'rejected' }),
      rec({ leaveDate: '2025-12-31', approvalStatus: 'approved' }), // other year
    ],
    legacy: [
      { leaveId: 'L1', employeeUid: ME, leaveType: 'personal', startDate: '2026-03-04', endDate: '2026-03-04', status: 'approved', matchStatus: 'matched' }, // same day as a record
      { leaveId: 'L2', employeeUid: ME, leaveType: 'personal', startDate: '2026-04-01', endDate: '2026-04-02', status: 'approved', matchStatus: 'matched' },
      { leaveId: 'L3', employeeUid: ME, leaveType: 'personal', startDate: '2026-05-01', endDate: '2026-05-01', status: 'pending', matchStatus: 'matched' },
      { leaveId: 'L4', employeeUid: ME, leaveType: 'personal', startDate: '2026-06-01', endDate: '2026-06-01', status: 'approved', matchStatus: 'unmatched' },
    ],
  }) });
  const personal = (await service.balance(me, ME, 2026)).find((r) => r.leaveType === 'personal');
  assert.equal(personal.usedDays, 3.5, '1 + 0.5 approved records + 2 legacy days; same-day legacy not doubled');
  assert.equal(personal.totalDays, 6);
  assert.equal(personal.remainingDays, 2.5, 'stored used/remaining are ignored');
  assert.equal(personal.pendingDays, 1);
  assert.equal(personal.available, true);
});

test('an entitlement for a type with no verifiable deductions has no remaining figure', async () => {
  const service = createLeaveService({ repositories: makeRepos({
    balances: [{ employeeUid: ME, year: 2026, leaveType: 'maternity', totalDays: 90, usedDays: 0, remainingDays: 90 }],
  }) });
  const maternity = (await service.balance(me, ME, 2026)).find((r) => r.leaveType === 'maternity');
  assert.equal(maternity.totalDays, 90);
  assert.equal(maternity.remainingDays, null);
  assert.equal(maternity.unavailableReason, 'deductions_not_tracked');
});

test('personal report uses the same records-first rows and balances as the leave pages', async () => {
  const { createReportService } = require('../src/services/reportService');
  const repos = makeRepos({
    balances: [{ employeeUid: ME, year: 2026, leaveType: 'vacation', totalDays: 10, usedDays: 0, remainingDays: 10 }],
    records: [
      rec({ leaveDate: '2026-03-04', leaveType: 'vacation', approvalStatus: 'approved' }),
      rec({ leaveDate: '2026-03-05', leaveType: 'vacation' }),
      rec({ leaveDate: '2026-04-02', leaveType: 'vacation', approvalStatus: 'approved' }),
    ],
  });
  repos.employees = { async findByUid(uid) { return { employeeUid: uid, employeeId: '1', firstNameTh: 'ก', lastNameTh: 'ข', department: 'D', position: 'P' }; } };
  repos.attendance = { async findMonthly() { return null; }, async findForEmployee() { return []; }, async latestDailyDate() { return null; } };
  repos.leaveRecords.coveredPeriods = async () => ['2026-03'];
  repos.leaveRecords.listBetween = async () => [];
  const report = await createReportService({ repositories: repos }).personal(me, { year: '2026', month: '3' });
  assert.deepEqual(report.leaveRows.map((r) => r.statusLabel), ['บันทึกแล้ว · รออนุมัติ', 'อนุมัติแล้ว']);
  assert.equal(report.leaveRows.length, 2, 'only March rows');
  const vacation = report.leaveBalances.find((b) => b.leaveType === 'vacation');
  assert.equal(vacation.remainingDays, 8, 'two approved days (March and April) deducted; the undecided one is not');
  assert.equal(report.remainingLeaveDays, 8);
  assert.equal(report.leaveBalances.find((b) => b.leaveType === 'sick').remainingDays, null);
});

test('no entitlement anywhere: remaining is null, not 0', async () => {
  const { createReportService } = require('../src/services/reportService');
  const repos = makeRepos({ records: [rec({ approvalStatus: 'approved' })] });
  repos.employees = { async findByUid(uid) { return { employeeUid: uid, employeeId: '1', firstNameTh: 'ก', lastNameTh: 'ข', department: 'D', position: 'P' }; } };
  repos.attendance = { async findMonthly() { return null; }, async findForEmployee() { return []; }, async latestDailyDate() { return null; } };
  repos.leaveRecords.coveredPeriods = async () => [];
  repos.leaveRecords.listBetween = async () => [];
  const report = await createReportService({ repositories: repos }).personal(me, { year: '2026', month: '3' });
  assert.equal(report.remainingLeaveDays, null);
});
