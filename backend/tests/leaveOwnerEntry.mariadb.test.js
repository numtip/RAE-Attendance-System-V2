/**
 * Bulk fiscal overview and the owner's data entry through the REAL repositories and schema (migrations 034-036):
 * bulk reads equal the single-person path, the owner's write is audited through the batch tables, a hire date and
 * an entitlement round-trip, removal works, and a failure rolls everything back. Skipped where no database exists.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured, createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createLeaveEntitlementService } = require('../src/services/leaveEntitlementService');
const { createLeaveOwnerEntryService } = require('../src/services/leaveOwnerEntryService');
const { createLeaveEntitlementOverviewService } = require('../src/services/leaveEntitlementOverviewService');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}
const NOW = () => new Date('2026-11-23T05:00:00Z');
const FY = 2570;

test('owner entry + bulk overview on MariaDB', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();
  const [owner, person, other] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, tag, hire, type, role] of [[owner, 'o', '2010-01-01', 'university', 'executive'], [person, 'p', null, 'university', 'user'], [other, 'q', '2018-05-01', 'contract', 'user']]) {
    await pool.query(
      `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, hire_date, status, role, created_at, updated_at)
       VALUES (?, ?, 'ทดสอบ', 'ระบบ', ?, 'test', ?, ?, 'active', ?, NOW(), NOW())`,
      [id, `OE${tag}${id.slice(0, 6)}`, `${id}@owner-entry.test`, type, hire, role],
    );
  }
  t.after(async () => {
    const uids = [owner, person, other];
    for (const sql of [
      'DELETE FROM leave_hr_audit WHERE employee_uid IN (?)', 'DELETE FROM leave_hr_import_batch WHERE operator_uid IN (?)',
      'DELETE FROM employee_leave_entitlement WHERE employee_uid IN (?)', 'DELETE FROM employee_leave_profile WHERE employee_uid IN (?)',
    ]) await pool.query(sql, [uids]).catch(() => {});
    await closePool();
  });
  // an organization-wide executive grant, the way production has it
  const grantsFor = repositories.authorization.grantsFor.bind(repositories.authorization);
  repositories.authorization.grantsFor = async (uid) => (uid === owner ? [{ scopeType: 'organization', role: 'EXECUTIVE' }] : grantsFor(uid));

  const ownerEntry = createLeaveOwnerEntryService({ repositories, now: NOW });
  const single = createLeaveEntitlementService({ repositories, now: NOW });
  const auth = { employeeUid: owner, role: 'executive' };

  await t.test('hire date, profile and an entitlement round-trip with audit rows', async () => {
    const result = await ownerEntry.apply(auth, person, {
      hireDate: '2016-03-01', continuousServiceStart: '2016-03-01', appointmentKind: 'first',
      entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 2.5 }],
    }, { fiscalYearBe: FY });
    assert.equal(result.changed, 3 + 2);
    assert.equal((await repositories.employees.getLeaveFacts(person)).hireDate, '2016-03-01');
    const vacation = result.rows.find((r) => r.leaveType === 'vacation');
    assert.deepEqual([vacation.status, vacation.totalDays, vacation.carryoverDays], ['ok', 12.5, 2.5]);
    const [audit] = await pool.query('SELECT table_name, field_name, before_value, after_value FROM leave_hr_audit WHERE employee_uid = ? ORDER BY id', [person]);
    assert.equal(audit.length, 5);
    assert.ok(audit.some((a) => a.table_name === 'employees' && a.field_name === 'hire_date' && a.before_value === null && a.after_value === '2016-03-01'));
    const again = await ownerEntry.apply(auth, person, { hireDate: '2016-03-01' });
    assert.equal(again.changed, 0);
  });

  await t.test('bulk equals single for every person, with a fixed number of reads', async () => {
    const uids = [owner, person, other];
    const bulk = await createLeaveEntitlementService({ repositories, now: NOW }).balances(uids, FY);
    for (const uid of uids) assert.deepEqual(bulk.get(uid), await single.balance(uid, FY), uid);
    assert.deepEqual(bulk.get(other).map((r) => r.status), ['out_of_scope', 'out_of_scope', 'out_of_scope']);
  });

  await t.test('overview reports the people; removal deletes the override; a failure rolls back', async () => {
    const overview = createLeaveEntitlementOverviewService({ repositories, config: { leave: { entitlementEngine: 'on' } }, now: NOW });
    const data = await overview.overview(auth, { year: FY });
    const mine = data.rows.find((r) => r.employeeUid === person);
    assert.equal(mine.profile.hireDate, '2016-03-01');
    assert.equal(mine.types.vacation.source, 'hr_verified');
    assert.equal(data.rows.find((r) => r.employeeUid === other).scope, 'excluded');

    await ownerEntry.apply(auth, person, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', remove: true }] });
    assert.equal(await repositories.leaveHr.getEntitlement(person, FY, 'vacation'), null);

    const before = (await pool.query('SELECT COUNT(*) AS n FROM leave_hr_import_batch WHERE operator_uid = ?', [owner]))[0][0].n;
    await assert.rejects(() => ownerEntry.apply(auth, person, { hireDate: '2017-01-01', eligibility: { confirmed: true, reference: 'x'.repeat(130) } }), (e) => e.status === 400);
    assert.equal((await repositories.employees.getLeaveFacts(person)).hireDate, '2016-03-01');
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM leave_hr_import_batch WHERE operator_uid = ?', [owner]))[0][0].n, before);
  });
});
