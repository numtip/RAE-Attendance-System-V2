const test = require('node:test');
const assert = require('node:assert/strict');

const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { LeaveRepository } = require('../src/repositories/leaveRepository');
const { LeaveRecordRepository } = require('../src/repositories/leaveRecordRepository');
const { LeaveHrRepository } = require('../src/repositories/leaveHrRepository');
const { createLeaveEntitlementService } = require('../src/services/leaveEntitlementService');
const { createLeaveEntitlementOverviewService } = require('../src/services/leaveEntitlementOverviewService');
const { createLeaveOwnerEntryService } = require('../src/services/leaveOwnerEntryService');
const { DIVISIONS } = require('../src/config/organization');

const EXEC = 'eeeeeeee-0000-0000-0000-00000000000e';
const MGR = 'ffffffff-0000-0000-0000-00000000000f';
const U1 = 'aaaaaaaa-0000-0000-0000-00000000000a'; // university, hire date known
const U2 = 'aaaaaaaa-0000-0000-0000-00000000000b'; // university, hire date MISSING
const D1 = 'bbbbbbbb-0000-0000-0000-00000000000b'; // department: needs the owner's decision
const C1 = 'cccccccc-0000-0000-0000-00000000000c'; // contract: excluded
const USER = 'dddddddd-0000-0000-0000-00000000000d';
const NOW = () => new Date('2026-11-23T05:00:00Z');
const FY = 2570;
const DIV = DIVISIONS[0].code;

const emp = (uid, type, extra = {}) => ({ employeeUid: uid, employeeId: uid.slice(0, 4), employeeType: type, status: 'active', hireDate: '2015-04-01', firstNameTh: 'ทดสอบ', lastNameTh: uid.slice(0, 2), role: 'user', ...extra });

function build({ withHr = false } = {}) {
  const employees = new EmployeeRepository([
    emp(EXEC, 'university', { role: 'executive' }), emp(MGR, 'university', { role: 'manager' }), emp(U1, 'university'),
    emp(U2, 'university', { hireDate: null }), emp(D1, 'department'), emp(C1, 'contract'), emp(USER, 'university'),
  ]);
  const leaveRecords = new LeaveRecordRepository();
  leaveRecords.coverage = ['2026-10', '2026-11'].map((sourcePeriod) => ({ sourceSystem: 'hip', sourcePeriod }));
  leaveRecords.records = [
    { recordUid: 'r1', employeeUid: U1, leaveDate: '2026-11-03', leaveType: 'sick', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate', approvalStatus: 'approved', sourceSystem: 'hip' },
    { recordUid: 'r2', employeeUid: U1, leaveDate: '2026-11-04', leaveType: 'vacation', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate', approvalStatus: 'approved', sourceSystem: 'hip' },
  ];
  const repositories = {
    authorization: {
      async grantsFor(uid) {
        if (uid === EXEC) return [{ scopeType: 'organization', role: 'EXECUTIVE' }];
        if (uid === MGR) return [{ scopeType: 'org_unit', role: 'MANAGER', orgUnitCode: DIV }];
        return [];
      },
      async uidsInOrgUnits() { return [U1]; },
      async listMemberships() { return [{ employeeUid: U1, orgUnitCode: DIV }, { employeeUid: U2, orgUnitCode: DIV }]; },
    },
    employees, leave: new LeaveRepository([], []), leaveRecords, leaveHr: new LeaveHrRepository({ employees }),
  };
  if (withHr) {
    // U1 has HR-verified rows for all three types, so every type is determined for that person.
    for (const [leaveType, entitlementDays, carryoverDays] of [['sick', 60, null], ['personal', 15, null], ['vacation', 10, 0]]) {
      repositories.leaveHr.entitlements.set(`${U1}|${FY}|${leaveType}`, { employeeUid: U1, fiscalYearBe: FY, leaveType, entitlementDays, carryoverDays, usageBaselineDays: null, usageBaselineThrough: null, sourceReference: 't', importBatchUid: 'b', verifiedByUid: EXEC });
    }
    repositories.leaveHr.profiles.set(U1, { employeeUid: U1, continuousServiceStart: '2015-04-01', appointmentKind: 'other', eligibilityConfirmed: null, eligibilityReference: null, sourceReference: 't', verifiedByUid: EXEC });
  }
  const config = (flag) => ({ leave: { entitlementEngine: flag } });
  return {
    repositories,
    single: createLeaveEntitlementService({ repositories, now: NOW }),
    overview: (flag = 'on') => createLeaveEntitlementOverviewService({ repositories, config: config(flag), now: NOW }),
    owner: createLeaveOwnerEntryService({ repositories, now: NOW }),
  };
}
const exec = { employeeUid: EXEC, role: 'executive' };

test('the bulk path returns exactly what the single path returns, person by person', async () => {
  const { single, repositories } = build({ withHr: true });
  const uids = [U1, U2, D1, C1, USER];
  const bulk = await createLeaveEntitlementService({ repositories, now: NOW }).balances(uids, FY);
  for (const uid of uids) assert.deepEqual(bulk.get(uid), await single.balance(uid, FY), uid);
});

test('the bulk path runs a fixed number of repository reads however many people are asked for', async () => {
  const { repositories } = build({ withHr: true });
  const calls = {};
  for (const [name, repo] of [['employees', repositories.employees], ['leaveHr', repositories.leaveHr], ['leaveRecords', repositories.leaveRecords], ['leave', repositories.leave]]) {
    for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter((m) => m !== 'constructor')) {
      const original = repo[method].bind(repo);
      repo[method] = (...args) => { calls[`${name}.${method}`] = (calls[`${name}.${method}`] || 0) + 1; return original(...args); };
    }
  }
  await createLeaveEntitlementService({ repositories, now: NOW }).balances([U1, U2, D1, C1, USER], FY);
  assert.ok(Object.values(calls).every((n) => n === 1), JSON.stringify(calls));
  assert.ok(Object.values(calls).reduce((a, b) => a + b, 0) <= 8);
});

test('overview: missing data for one person does not block the others, and incomplete people are never summed as zero', async () => {
  const { overview } = build({ withHr: true });
  const data = await overview().overview(exec, { year: FY });
  const by = Object.fromEntries(data.rows.map((r) => [r.employeeUid, r]));
  // U1 is fully determined; U2 lacks a hire date for vacation/personal only; D1 (section employee) is covered by
  // its own policy; C1 (section contract) waits for the owner's confirmation.
  assert.equal(by[U1].scope, 'in_policy');
  assert.deepEqual(['sick', 'personal', 'vacation'].map((t) => by[U1].types[t].status), ['ok', 'ok', 'ok']);
  assert.deepEqual(by[U1].types.sick.remainingDays, 59);
  assert.equal(by[U2].types.vacation.remainingDays, null);
  assert.ok(by[U2].missing.includes('hireDate'));
  assert.equal(by[D1].scope, 'in_policy');
  assert.deepEqual(['sick', 'personal', 'vacation'].map((t) => by[D1].types[t].totalDays), [15, 5, 10]);
  assert.equal(by[D1].types.vacation.carryoverDays, 0);
  assert.deepEqual([by[D1].policy.family, by[D1].policy.requires.carryover, by[D1].policy.requires.appointmentKind], ['section_employee', false, false]);
  assert.equal(by[C1].scope, 'unconfirmed');
  assert.deepEqual(by[C1].policy.requires.hireDateFor, []);
  assert.equal(data.summary.excluded, 0);
  assert.equal(data.summary.unconfirmed, 1);
  assert.deepEqual(data.summary.byPolicy.section_contract, { people: 1, unconfirmed: 1, fullyDetermined: 0 });
  assert.equal(data.summary.byPolicy.section_employee.fullyDetermined, 1);
  assert.equal(data.summary.fullyDetermined >= 1, true);
  // totals only add determined rows: sick determined for U1 (and U2: sick needs no hire date) – never more than that
  const sick = data.summary.byType.sick;
  const expected = data.rows.filter((r) => r.types.sick.available && r.types.sick.remainingDays !== null);
  assert.equal(sick.determined, expected.length);
  assert.equal(sick.remainingDays, expected.reduce((n, r) => n + r.types.sick.remainingDays, 0));
  assert.ok(!('flags' in by[U1].types.sick) || by[U1].types.sick.flags.every((f) => typeof f === 'string'));
});

test('overview RBAC: executive sees everyone and the stored facts, manager only the granted unit without facts, others are refused', async () => {
  const { overview } = build({ withHr: true });
  const asExec = await overview().overview(exec, { year: FY });
  assert.equal(asExec.rows.length, 7);
  assert.equal(asExec.canEdit, true);
  assert.equal(asExec.rows.find((r) => r.employeeUid === U1).profile.hireDate, '2015-04-01');
  const asMgr = await overview().overview({ employeeUid: MGR, role: 'manager' }, { year: FY });
  assert.deepEqual(asMgr.rows.map((r) => r.employeeUid).sort(), [MGR, U1].sort());
  assert.equal(asMgr.canEdit, false);
  assert.ok(asMgr.rows.every((r) => !('profile' in r)));
  await assert.rejects(() => overview().overview({ employeeUid: USER, role: 'user' }, { year: FY }), (e) => e.status === 403);
});

test('overview: flag off is refused, shadow and on are served, bad input is a 400, division filters', async () => {
  const { overview } = build();
  await assert.rejects(() => overview('off').overview(exec, { year: FY }), (e) => e.status === 503 && e.code === 'LEAVE_ENTITLEMENT_ENGINE_OFF');
  assert.ok((await overview('shadow').overview(exec, { year: FY })).rows.length > 0);
  await assert.rejects(() => overview().overview(exec, { year: 2568 }), (e) => e.status === 400);
  await assert.rejects(() => overview().overview(exec, { year: FY, division: 'nope' }), (e) => e.status === 400);
  const one = await overview().overview(exec, { year: FY, division: DIV });
  assert.deepEqual(one.rows.map((r) => r.employeeUid).sort(), [U1, U2].sort());
  // default year is the current fiscal year (2026-11-23 is in FY2570)
  assert.equal((await overview().overview(exec, {})).fiscalYear.be, 2570);
});

// ------------------------------------------------------------ owner entry

test('owner entry: only an executive with an organization grant may write', async () => {
  const { owner } = build();
  for (const auth of [{ employeeUid: MGR, role: 'manager' }, { employeeUid: USER, role: 'user' }]) {
    await assert.rejects(() => owner.apply(auth, U2, { hireDate: '2020-01-01' }), (e) => e.status === 403);
  }
  await assert.rejects(() => owner.apply(exec, 'no-such-uid', { hireDate: '2020-01-01' }), (e) => e.status === 404);
});

test('owner entry: a hire date turns an unknown balance into a number and is audited; repeating it changes nothing', async () => {
  const { owner, repositories } = build();
  const before = await owner.apply(exec, U2, { entitlements: [] }).catch((e) => e);
  assert.equal(before.status, 400); // nothing to change
  const first = await owner.apply(exec, U2, { hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', appointmentKind: 'first' }, { fiscalYearBe: FY });
  assert.equal(first.changed, 3);
  assert.equal(first.rows.find((r) => r.leaveType === 'personal').status, 'ok');
  // vacation still needs the carry-over, which is never guessed
  const vacation = first.rows.find((r) => r.leaveType === 'vacation');
  assert.deepEqual([vacation.status, vacation.missing, vacation.remainingDays], ['unknown', ['vacationCarryoverDays'], null]);
  assert.equal((await repositories.employees.getLeaveFacts(U2)).hireDate, '2015-04-01');
  const audit = repositories.leaveHr.audit;
  assert.deepEqual(audit.map((a) => [a.tableName, a.fieldName, a.beforeValue, a.afterValue, a.actorUid]).sort(),
    [['employee_leave_profile', 'appointment_kind', null, 'first', EXEC], ['employee_leave_profile', 'continuous_service_start', null, '2015-04-01', EXEC], ['employees', 'hire_date', null, '2015-04-01', EXEC]].sort());
  const again = await owner.apply(exec, U2, { hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', appointmentKind: 'first' }, { fiscalYearBe: FY });
  assert.equal(again.changed, 0);
  assert.equal(repositories.leaveHr.audit.length, 3);
});

test('owner entry: confirming a section-contract worker records a reference and lets the engine compute (10 / 5 / 10, no carry-over)', async () => {
  const { owner, overview } = build();
  const result = await owner.apply(exec, C1, { eligibility: { confirmed: true } }, { fiscalYearBe: FY });
  assert.deepEqual(result.rows.map((r) => [r.status, r.totalDays]), [['ok', 10], ['ok', 5], ['ok', 10]]);
  const row = (await overview().overview(exec, { year: FY })).rows.find((r) => r.employeeUid === C1);
  assert.equal(row.profile.eligibilityConfirmed, true);
  assert.match(row.profile.eligibilityReference, /^owner-confirmed 2026-11-23$/);
  // the owner can also decide that a person is outside the policy
  const out = await owner.apply(exec, C1, { eligibility: { confirmed: false, reference: 'owner decision' } }, { fiscalYearBe: FY });
  assert.ok(out.rows.every((r) => r.status === 'out_of_scope'));
  // and clear the decision again
  const cleared = await owner.apply(exec, C1, { eligibility: { confirmed: null } }, { fiscalYearBe: FY });
  assert.ok(cleared.rows.every((r) => r.status === 'needs_hr'));
});

test('owner entry follows the person\'s policy: no carry-over for section policies, no confirmation into an unmapped type', async () => {
  const { owner, repositories } = build();
  for (const uid of [D1, C1]) {
    await assert.rejects(() => owner.apply(exec, uid, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 2 }] }), (e) => e.status === 400 && /carry-over/.test(e.message));
  }
  const ok = await owner.apply(exec, D1, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 0 }] }, { fiscalYearBe: FY });
  assert.equal(ok.rows.find((r) => r.leaveType === 'vacation').carryoverDays, 0);
  // a section employee needs no appointment kind or continuous-service date: the vacation figure is there without them
  assert.equal(ok.rows.find((r) => r.leaveType === 'vacation').status, 'ok');
  assert.equal(await repositories.leaveHr.getProfile(D1), null);
});

test('owner entry: entitlement override, carry-over and removal, with validation', async () => {
  const { owner, repositories } = build();
  const set = await owner.apply(exec, U1, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 4 }] });
  const vac = set.rows.find((r) => r.leaveType === 'vacation');
  assert.deepEqual([vac.status, vac.carryoverDays, vac.totalDays, vac.source], ['ok', 4, 14, 'hr_verified']);
  assert.equal((await repositories.leaveHr.getEntitlement(U1, FY, 'vacation')).sourceReference, 'owner-entry');
  const removed = await owner.apply(exec, U1, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', remove: true }] });
  assert.equal(removed.changed, 1);
  assert.equal(await repositories.leaveHr.getEntitlement(U1, FY, 'vacation'), null);
  const reject = (payload) => owner.apply(exec, U1, payload).then(() => assert.fail('should reject'), (e) => assert.equal(e.status, 400));
  await reject({ entitlements: [{ fiscalYearBe: FY, leaveType: 'sick', entitlementDays: 7.3 }] });
  await reject({ entitlements: [{ fiscalYearBe: FY, leaveType: 'sick', entitlementDays: 10, carryoverDays: 2 }] });
  await reject({ entitlements: [{ fiscalYearBe: 2568, leaveType: 'sick', entitlementDays: 10 }] });
  await reject({ entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, usageBaselineDays: 2 }] });
  await reject({ entitlements: [{ fiscalYearBe: FY, leaveType: 'sick', entitlementDays: 60, usageBaselineDays: 3, usageBaselineThrough: '2026-09-30' }] }); // before the fiscal year
  const baseline = await owner.apply(exec, U1, { entitlements: [{ fiscalYearBe: FY, leaveType: 'sick', entitlementDays: 60, usageBaselineDays: 3, usageBaselineThrough: '2026-10-31' }] });
  assert.equal(baseline.changed, 3);
  assert.equal(baseline.rows.find((r) => r.leaveType === 'sick').usedDays >= 3, true);
  await reject({ hireDate: '2030-01-01' });
  await reject({ hireDate: '2020-02-30' });
  await reject({ appointmentKind: 'whatever' });
  await reject({ surprise: 1 });
});

test('owner entry: a failure part-way writes nothing (one transaction)', async () => {
  const { owner, repositories } = build();
  const original = repositories.leaveHr.appendAudit.bind(repositories.leaveHr);
  repositories.leaveHr.appendAudit = async () => { throw new Error('disk full'); };
  await assert.rejects(() => owner.apply(exec, U2, { hireDate: '2015-04-01' }), /disk full/);
  repositories.leaveHr.appendAudit = original;
  assert.equal((await repositories.employees.getLeaveFacts(U2)).hireDate, null);
  assert.equal(repositories.leaveHr.batches.length, 0);
});
