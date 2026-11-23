const test = require('node:test');
const assert = require('node:assert/strict');

const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { LeaveHrRepository } = require('../src/repositories/leaveHrRepository');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');

function setup() {
  const employees = new EmployeeRepository([
    { employeeUid: 'u1', employeeId: '9001', employeeType: 'university', status: 'active', hireDate: null, firstNameTh: 'a', lastNameTh: 'b' },
    { employeeUid: 'u2', employeeId: '9002', employeeType: 'department', status: 'active', hireDate: '2020-01-01', firstNameTh: 'c', lastNameTh: 'd' },
  ]);
  return { employees, repo: new LeaveHrRepository({ employees }) };
}

const profile = (uid, extra = {}) => ({
  employeeUid: uid, continuousServiceStart: '2015-04-01', appointmentKind: 'first', eligibilityConfirmed: null,
  eligibilityReference: null, sourceReference: 'doc', verifiedByUid: 'u2', ...extra,
});
const entitlement = (uid, type, extra = {}) => ({
  employeeUid: uid, fiscalYearBe: 2570, leaveType: type, entitlementDays: 10, carryoverDays: null, usageBaselineDays: null,
  usageBaselineThrough: null, sourceReference: 'doc', importBatchUid: 'b1', verifiedByUid: 'u2', ...extra,
});

test('the fixture repositories expose the HR repository and the leave facts', async () => {
  const repos = createFixtureRepositories();
  assert.equal(typeof repos.leaveHr.upsertProfile, 'function');
  assert.equal(typeof repos.employees.getLeaveFacts, 'function');
});

test('leave facts carry the hire date and null means unknown', async () => {
  const { employees } = setup();
  assert.deepEqual(await employees.getLeaveFacts('u1'), { employeeUid: 'u1', employeeId: '9001', employeeType: 'university', status: 'active', hireDate: null });
  assert.equal((await employees.getLeaveFacts('u2')).hireDate, '2020-01-01');
  assert.equal(await employees.getLeaveFacts('nobody'), null);
});

test('profiles: upsert replaces, a missing profile is null, bulk read is one call', async () => {
  const { repo } = setup();
  assert.equal(await repo.getProfile('u1'), null);
  await repo.upsertProfile(profile('u1'));
  await repo.upsertProfile(profile('u1', { appointmentKind: 'other' }));
  assert.equal((await repo.getProfile('u1')).appointmentKind, 'other');
  await repo.upsertProfile(profile('u2'));
  assert.deepEqual((await repo.listProfiles(['u1', 'u2', 'u3'])).map((p) => p.employeeUid).sort(), ['u1', 'u2']);
  assert.deepEqual(await repo.listProfiles([]), []);
});

test('entitlements are unique per (employee, fiscal year, type) and keyed by the Buddhist fiscal year', async () => {
  const { repo } = setup();
  await repo.upsertEntitlement(entitlement('u1', 'vacation', { carryoverDays: 4 }));
  await repo.upsertEntitlement(entitlement('u1', 'vacation', { carryoverDays: 6 }));
  await repo.upsertEntitlement(entitlement('u1', 'sick', { entitlementDays: 60 }));
  await repo.upsertEntitlement(entitlement('u1', 'sick', { fiscalYearBe: 2571, entitlementDays: 60 }));
  const year = await repo.listEntitlements('u1', 2570);
  assert.deepEqual(year.map((e) => [e.leaveType, e.carryoverDays]), [['sick', null], ['vacation', 6]]);
  assert.equal((await repo.getEntitlement('u1', 2570, 'vacation')).carryoverDays, 6);
  assert.equal(await repo.getEntitlement('u1', 2569, 'vacation'), null);
  assert.equal((await repo.listEntitlementsForYear(['u1', 'u2'], 2571)).length, 1);
});

test('a batch is unique per kind and file hash; audit rows come back in order', async () => {
  const { repo } = setup();
  const sha = 'a'.repeat(64);
  const uid = await repo.insertBatch({ kind: 'profile', fileSha256: sha, rowsRead: 2, rowsApplied: 2, rowsUnchanged: 0, operatorUid: 'u2' });
  assert.equal((await repo.findBatch('profile', sha)).batchUid, uid);
  assert.equal(await repo.findBatch('entitlement', sha), null);
  await assert.rejects(() => repo.insertBatch({ kind: 'profile', fileSha256: sha, rowsRead: 1, rowsApplied: 1, rowsUnchanged: 0, operatorUid: 'u2' }), { code: 'ER_DUP_ENTRY' });
  await repo.appendAudit([
    { batchUid: uid, employeeUid: 'u1', tableName: 'employees', fieldName: 'hire_date', beforeValue: null, afterValue: '2015-04-01', actorUid: 'u2' },
    { batchUid: uid, employeeUid: 'u1', tableName: 'employee_leave_profile', fieldName: 'appointment_kind', beforeValue: 'first', afterValue: 'other', actorUid: 'u2' },
  ]);
  assert.deepEqual((await repo.listAudit(uid)).map((a) => a.fieldName), ['hire_date', 'appointment_kind']);
});

test('a failed transaction leaves nothing behind, including the hire date', async () => {
  const { repo, employees } = setup();
  await assert.rejects(() => repo.transaction(async (tx) => {
    await tx.setHireDate('u1', '2015-04-01');
    await tx.upsertProfile(profile('u1'));
    await tx.upsertEntitlement(entitlement('u1', 'vacation'));
    await tx.insertBatch({ kind: 'profile', fileSha256: 'b'.repeat(64), rowsRead: 1, rowsApplied: 1, rowsUnchanged: 0, operatorUid: 'u2' });
    throw new Error('boom');
  }), /boom/);
  assert.equal((await employees.getLeaveFacts('u1')).hireDate, null);
  assert.equal(await repo.getProfile('u1'), null);
  assert.deepEqual(await repo.listEntitlements('u1', 2570), []);
  assert.equal(await repo.findBatch('profile', 'b'.repeat(64)), null);
});

test('a successful transaction keeps its writes', async () => {
  const { repo, employees } = setup();
  await repo.transaction(async (tx) => {
    await tx.setHireDate('u1', '2015-04-01');
    await tx.upsertProfile(profile('u1'));
  });
  assert.equal((await employees.getLeaveFacts('u1')).hireDate, '2015-04-01');
  assert.ok(await repo.getProfile('u1'));
});
