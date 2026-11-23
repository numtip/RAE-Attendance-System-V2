/**
 * The HR leave-data tables (034-036) against the REAL schema: constraints, bulk reads, the audit trail and
 * transaction rollback. Skipped wherever no database is present (same gate as the other *.mariadb suites).
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createLeaveHrMariaDbRepository } = require('../src/repositories/mariadb/leaveHrMariaDbRepository');
const { createEmployeeMariaDbRepository } = require('../src/repositories/mariadb/employeeMariaDbRepository');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

async function makeEmployee(pool, tag) {
  const uid = randomUUID();
  await pool.query(
    `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, status, created_at, updated_at)
     VALUES (?, ?, 'ทดสอบ', 'ระบบ', ?, 'test', 'university', 'active', NOW(), NOW())`,
    [uid, `T${tag}${uid.slice(0, 6)}`, `${uid}@leave-hr.test`],
  );
  return uid;
}

test('HR leave tables: constraints, bulk reads, audit and rollback', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repo = createLeaveHrMariaDbRepository(pool);
  const employees = createEmployeeMariaDbRepository(pool);
  const [a, b, operator] = [await makeEmployee(pool, 'a'), await makeEmployee(pool, 'b'), await makeEmployee(pool, 'o')];
  const uids = [a, b, operator];
  const batchUids = [];

  t.after(async () => {
    for (const sql of [
      ['DELETE FROM leave_hr_audit WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM leave_hr_import_batch WHERE operator_uid = ?', [operator]],
      ['DELETE FROM employee_leave_entitlement WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM employee_leave_profile WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM employees WHERE employee_uid IN (?)', [uids]],
    ]) await pool.query(sql[0], sql[1]).catch(() => {});
    await closePool();
  });

  const entitlement = (uid, type, extra = {}) => ({
    employeeUid: uid, fiscalYearBe: 2570, leaveType: type, entitlementDays: 10, carryoverDays: null, usageBaselineDays: null,
    usageBaselineThrough: null, sourceReference: 'doc', importBatchUid: randomUUID(), verifiedByUid: operator, ...extra,
  });

  await t.test('profile round-trips; null stays null (unknown) and booleans map', async () => {
    await repo.upsertProfile({ employeeUid: a, continuousServiceStart: '2015-04-01', appointmentKind: 'first', eligibilityConfirmed: null, eligibilityReference: null, sourceReference: 'doc 1', verifiedByUid: operator });
    await repo.upsertProfile({ employeeUid: b, continuousServiceStart: null, appointmentKind: null, eligibilityConfirmed: true, eligibilityReference: 'memo 3', sourceReference: 'doc 2', verifiedByUid: operator });
    const [pa, pb] = await Promise.all([repo.getProfile(a), repo.getProfile(b)]);
    assert.deepEqual([pa.continuousServiceStart, pa.appointmentKind, pa.eligibilityConfirmed], ['2015-04-01', 'first', null]);
    assert.deepEqual([pb.continuousServiceStart, pb.appointmentKind, pb.eligibilityConfirmed, pb.eligibilityReference], [null, null, true, 'memo 3']);
    assert.equal((await repo.listProfiles([a, b])).length, 2);
    await repo.upsertProfile({ ...pa, appointmentKind: 'other' });
    assert.equal((await repo.getProfile(a)).appointmentKind, 'other');
  });

  await t.test('the schema refuses a confirmation without its document reference', async () => {
    await assert.rejects(() => repo.upsertProfile({ employeeUid: a, continuousServiceStart: null, appointmentKind: null, eligibilityConfirmed: true, eligibilityReference: null, sourceReference: 'doc', verifiedByUid: operator }), /chk_employee_leave_profile_confirmation|CONSTRAINT/);
  });

  await t.test('entitlements: numbers are numbers, upsert keeps one row, bulk read is one query', async () => {
    await repo.upsertEntitlement(entitlement(a, 'vacation', { carryoverDays: 4.5 }));
    await repo.upsertEntitlement(entitlement(a, 'vacation', { carryoverDays: 6 }));
    await repo.upsertEntitlement(entitlement(a, 'sick', { entitlementDays: 60, usageBaselineDays: 2.5, usageBaselineThrough: '2026-11-01' }));
    await repo.upsertEntitlement(entitlement(b, 'vacation'));
    const mine = await repo.listEntitlements(a, 2570);
    assert.deepEqual(mine.map((e) => [e.leaveType, e.entitlementDays, e.carryoverDays, e.usageBaselineDays, e.usageBaselineThrough]),
      [['sick', 60, null, 2.5, '2026-11-01'], ['vacation', 10, 6, null, null]]);
    assert.equal((await repo.listEntitlementsForYear([a, b], 2570)).length, 3);
    assert.equal((await repo.listEntitlementsForYear([a, b], 2571)).length, 0);
    assert.equal((await repo.getEntitlement(b, 2570, 'vacation')).carryoverDays, null);
  });

  await t.test('the schema refuses carry-over on sick leave, off-step days, a lone baseline and a non-fiscal year', async () => {
    await assert.rejects(() => repo.upsertEntitlement(entitlement(b, 'sick', { carryoverDays: 3 })), /CONSTRAINT/);
    await assert.rejects(() => repo.upsertEntitlement(entitlement(b, 'personal', { entitlementDays: 45.3 })), /CONSTRAINT/);
    await assert.rejects(() => repo.upsertEntitlement(entitlement(b, 'personal', { usageBaselineDays: 2 })), /CONSTRAINT/);
    await assert.rejects(() => repo.upsertEntitlement(entitlement(b, 'personal', { fiscalYearBe: 2026 })), /CONSTRAINT/);
  });

  await t.test('batch ledger is unique per kind and file; audit rows are stored and read back', async () => {
    const sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const batchUid = await repo.insertBatch({ kind: 'profile', fileSha256: sha, rowsRead: 2, rowsApplied: 2, rowsUnchanged: 0, operatorUid: operator });
    batchUids.push(batchUid);
    assert.equal((await repo.findBatch('profile', sha)).batchUid, batchUid);
    assert.equal(await repo.findBatch('entitlement', sha), null);
    await assert.rejects(() => repo.insertBatch({ kind: 'profile', fileSha256: sha, rowsRead: 1, rowsApplied: 1, rowsUnchanged: 0, operatorUid: operator }), /Duplicate|ER_DUP_ENTRY/);
    await repo.appendAudit([{ batchUid, employeeUid: a, tableName: 'employees', fieldName: 'hire_date', beforeValue: null, afterValue: '2015-04-01', actorUid: operator }]);
    assert.deepEqual(await repo.listAudit(batchUid), [{ employeeUid: a, tableName: 'employees', fieldName: 'hire_date', entityKey: null, beforeValue: null, afterValue: '2015-04-01' }]);
  });

  await t.test('hire date: the existing column, readable through the leave facts', async () => {
    assert.equal((await employees.getLeaveFacts(a)).hireDate, null);
    assert.equal(await repo.setHireDate(a, '2015-04-01'), true);
    assert.equal((await employees.getLeaveFacts(a)).hireDate, '2015-04-01');
    assert.equal(await repo.setHireDate(randomUUID(), '2015-04-01'), false);
  });

  await t.test('a failed transaction rolls everything back', async () => {
    const before = (await repo.listEntitlements(b, 2570)).length;
    await assert.rejects(() => repo.transaction(async (tx) => {
      await tx.setHireDate(b, '2001-01-01');
      await tx.upsertEntitlement(entitlement(b, 'personal', { entitlementDays: 45 }));
      throw new Error('stop');
    }), /stop/);
    assert.equal((await repo.listEntitlements(b, 2570)).length, before);
    assert.equal((await employees.getLeaveFacts(b)).hireDate, null);
  });

  await t.test('a committed transaction persists', async () => {
    await repo.transaction(async (tx) => {
      await tx.setHireDate(b, '2001-01-01');
      await tx.upsertEntitlement(entitlement(b, 'personal', { entitlementDays: 45 }));
    });
    assert.equal((await employees.getLeaveFacts(b)).hireDate, '2001-01-01');
    assert.equal((await repo.getEntitlement(b, 2570, 'personal')).entitlementDays, 45);
  });
});
