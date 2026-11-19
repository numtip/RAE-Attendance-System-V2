const assert = require('node:assert/strict');
const test = require('node:test');

const { createLeaveReviewService } = require('../src/services/leaveReviewService');
const { createLeaveMonthlyReportService } = require('../src/services/leaveMonthlyReportService');
const { LeaveRecordRepository } = require('../src/repositories/leaveRecordRepository');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const EXEC = { role: 'executive', employeeUid: 'x' };

function setup() {
  const leaveRecords = new LeaveRecordRepository();
  const repositories = {
    leaveRecords,
    attendance: { async latestDailyDate() { return '2026-03-31'; } },
    leave: { async countAll() { return 0; }, async listOverlapping() { return []; } },
    employees: {
      async list() {
        return [
          { employeeUid: A, employeeId: '1001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', status: 'active' },
          { employeeUid: B, employeeId: '1002', firstNameTh: 'สมหญิง', lastNameTh: 'รักงาน', status: 'active' },
        ];
      },
    },
    authorization: {
      async grantsFor(uid) {
        if (uid === 'x') return [{ employeeUid: 'x', role: 'EXECUTIVE', scopeType: 'organization' }];
        if (uid === 'm') return [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }];
        return [];
      },
      async uidsInOrgUnits() { return [A, B]; },
    },
  };
  return { repositories, leaveRecords, review: createLeaveReviewService({ repositories }), report: createLeaveMonthlyReportService({ repositories }) };
}
const base = { employeeUid: A, leaveType: 'sick', reviewReason: null, sourceSystem: 'hip_daily_report_remark', sourcePeriod: '2026-03', sourceLine: 2 };
async function seed(repo) {
  await repo.insertIgnore([
    { ...base, leaveDate: '2026-03-04', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate' },
    { ...base, leaveDate: '2026-03-05', dayPart: 'PM', dayFraction: 0.5, reviewStatus: 'candidate' },
    { ...base, leaveDate: '2026-03-06', dayPart: 'UNKNOWN', dayFraction: null, reviewStatus: 'needs_review', reviewReason: 'both_scans_present' },
    { ...base, employeeUid: B, leaveDate: '2026-03-06', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate' },
  ]);
  await repo.coverage.push({ sourcePeriod: '2026-03', sourceSystem: 'hip_daily_report_remark' });
  const find = (uid, date) => repo.records.find((r) => r.employeeUid === uid && r.leaveDate === date);
  return { find };
}
const P = { year: '2026', month: '3' };

test('only an executive with an organization grant may list or decide; nobody gains it implicitly', async () => {
  const { review, leaveRecords } = setup();
  const { find } = await seed(leaveRecords);
  const uid = find(A, '2026-03-04').recordUid;
  for (const who of [{ role: 'manager', employeeUid: 'm' }, { role: 'admin', employeeUid: 'a' }, { role: 'user', employeeUid: A }, { role: 'executive', employeeUid: 'no-grant' }]) {
    await assert.rejects(() => review.list(who, P), (e) => e.status === 403, `list as ${who.role}`);
    await assert.rejects(() => review.decide(who, [{ recordUid: uid, action: 'approve' }]), (e) => e.status === 403, `decide as ${who.role}`);
  }
  assert.equal(find(A, '2026-03-04').approvalStatus, 'unverified');
});

test('list buckets and filters records; names are resolved server-side', async () => {
  const { review, leaveRecords } = setup();
  await seed(leaveRecords);
  const all = await review.list(EXEC, { ...P, filter: 'all' });
  assert.deepEqual(all.counts, { needs_review: 1, unverified: 3, approved: 0, rejected: 0 });
  assert.equal(all.rows.length, 4);
  const queue = await review.list(EXEC, P);
  assert.equal(queue.filter, 'needs_review');
  assert.equal(queue.rows.length, 1);
  assert.equal(queue.rows[0].employeeName, 'สมชาย ใจดี');
  assert.match(queue.rows[0].reasonLabels[0], /สแกนทั้งเข้าและออก/);
  await assert.rejects(() => review.list(EXEC, { ...P, filter: 'bogus' }), (e) => e.status === 400);
});

test('approving a normal candidate records who decided and writes an audit row; totals split approved from unverified', async () => {
  const { review, leaveRecords, report } = setup();
  const { find } = await seed(leaveRecords);
  const rec = find(A, '2026-03-04');
  const result = await review.decide(EXEC, [{ recordUid: rec.recordUid, action: 'approve', note: 'ตรวจแล้ว' }]);
  assert.equal(result.applied, 1);
  assert.equal(rec.approvalStatus, 'approved');
  assert.equal(rec.reviewedByUid, 'x');
  assert.equal(leaveRecords.audit.length, 1);
  assert.match(leaveRecords.audit[0].before, /approval=unverified/);
  assert.match(leaveRecords.audit[0].after, /approval=approved/);
  const r = await report.monthly(EXEC, P);
  assert.equal(r.recordedTotals.byType.sick.days, 2.5, 'approved + unverified candidates (the review item is not counted)');
  assert.equal(r.recordedTotals.byType.sick.approvedDays, 1);
});

test('a record under review cannot be approved without an explicit part of day; with one it becomes a counted day', async () => {
  const { review, leaveRecords } = setup();
  const { find } = await seed(leaveRecords);
  const rec = find(A, '2026-03-06');
  const refused = await review.decide(EXEC, [{ recordUid: rec.recordUid, action: 'approve' }]);
  assert.equal(refused.failed, 1);
  assert.match(refused.results[0].error, /dayPart/);
  assert.equal(rec.reviewStatus, 'needs_review');
  const ok = await review.decide(EXEC, [{ recordUid: rec.recordUid, action: 'approve', dayPart: 'AM' }]);
  assert.equal(ok.applied, 1);
  assert.deepEqual([rec.reviewStatus, rec.dayPart, rec.dayFraction, rec.reviewReason, rec.approvalStatus], ['candidate', 'AM', 0.5, null, 'approved']);
});

test('a rejection removes the record from every total and from the review queue, and cannot reclassify', async () => {
  const { review, leaveRecords, report } = setup();
  const { find } = await seed(leaveRecords);
  const rec = find(A, '2026-03-05');
  assert.equal((await review.decide(EXEC, [{ recordUid: rec.recordUid, action: 'reject', dayPart: 'FULL' }])).failed, 1);
  assert.equal((await review.decide(EXEC, [{ recordUid: rec.recordUid, action: 'reject' }])).applied, 1);
  const r = await report.monthly(EXEC, P);
  assert.equal(r.recordedTotals.byType.sick.days, 2, 'the rejected half-day is not counted');
  const rejected = await review.list(EXEC, { ...P, filter: 'rejected' });
  assert.equal(rejected.rows.length, 1);
  const unverified = await review.list(EXEC, { ...P, filter: 'unverified' });
  assert.ok(unverified.rows.every((row) => row.recordUid !== rec.recordUid));
});

test('input validation: bad action, long note, unknown record, empty or oversized batch, duplicate target', async () => {
  const { review, leaveRecords } = setup();
  const { find } = await seed(leaveRecords);
  const uid = find(A, '2026-03-04').recordUid;
  assert.match((await review.decide(EXEC, [{ recordUid: uid, action: 'delete' }])).results[0].error, /action/);
  assert.match((await review.decide(EXEC, [{ recordUid: uid, action: 'approve', note: 'x'.repeat(201) }])).results[0].error, /note/);
  assert.match((await review.decide(EXEC, [{ recordUid: 'nope', action: 'approve' }])).results[0].error, /not found/);
  await assert.rejects(() => review.decide(EXEC, []), (e) => e.status === 400);
  await assert.rejects(() => review.decide(EXEC, Array.from({ length: 201 }, () => ({}))), (e) => e.status === 400);
  // PM -> FULL on a day that already has a FULL row for the same employee/source is refused, not overwritten
  const pm = find(A, '2026-03-05');
  await leaveRecords.insertIgnore([{ ...base, leaveDate: '2026-03-05', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate' }]);
  const clash = await review.decide(EXEC, [{ recordUid: pm.recordUid, action: 'approve', dayPart: 'FULL' }]);
  assert.match(clash.results[0].error, /already/);
  assert.equal(pm.dayPart, 'PM');
});
