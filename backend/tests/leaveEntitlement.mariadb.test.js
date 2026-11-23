/**
 * The fiscal-year balance through the REAL repositories and schema: HR-verified rows (035), the baseline cutoff,
 * the records table and the coverage table, then the `leaveService` entry point with the flag on. Skipped
 * wherever no database is present.
 *
 * Fiscal year 2569 (2025-10-01 .. 2026-09-30) is used on purpose: it is wholly in the past, so the months that
 * must be covered do not depend on the day the test runs.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured, createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createLeaveService } = require('../src/services/leaveService');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const SOURCE = 'test_leave_entitlement';
const MONTHS_2569 = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

test('fiscal balance end to end on MariaDB: HR row, baseline cutoff, coverage and RBAC', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();
  const uid = randomUUID();
  const other = randomUUID();
  const operator = randomUUID();
  const batchUid = randomUUID();

  for (const [id, tag] of [[uid, 'p'], [other, 'q'], [operator, 'o']]) {
    await pool.query(
      `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, hire_date, status, role, created_at, updated_at)
       VALUES (?, ?, 'ทดสอบ', 'ระบบ', ?, 'test', 'university', '2015-04-01', 'active', 'user', NOW(), NOW())`,
      [id, `E${tag}${id.slice(0, 6)}`, `${id}@leave-entitlement.test`],
    );
  }
  t.after(async () => {
    for (const [sql, params] of [
      ['DELETE FROM employee_leave_record WHERE employee_uid = ?', [uid]],
      ['DELETE FROM employee_leave_record_coverage WHERE source_system = ?', [SOURCE]],
      ['DELETE FROM employee_leave_entitlement WHERE employee_uid = ?', [uid]],
      ['DELETE FROM employee_leave_profile WHERE employee_uid = ?', [uid]],
      ['DELETE FROM employees WHERE employee_uid IN (?)', [[uid, other, operator]]],
    ]) await pool.query(sql, params).catch(() => {});
    await closePool();
  });

  const record = (date, type, extra = {}) => ({
    employeeUid: uid, leaveDate: date, leaveType: type, dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate', reviewReason: null,
    sourceSystem: SOURCE, sourcePeriod: date.slice(0, 7), sourceLine: Math.floor(Math.random() * 1e6), ...extra,
  });
  await repositories.leaveRecords.insertIgnore([
    record('2025-11-03', 'sick'), // before the HR baseline date: already inside the baseline
    record('2026-02-02', 'sick'),
    record('2026-02-03', 'sick'),
    record('2026-03-02', 'vacation', { dayPart: 'AM', dayFraction: 0.5 }),
  ]);
  await pool.query("UPDATE employee_leave_record SET approval_status = 'approved' WHERE employee_uid = ? AND NOT (leave_date = '2026-02-03')", [uid]); // 02-03 stays unverified
  for (const month of MONTHS_2569) await repositories.leaveRecords.upsertCoverage({ sourceSystem: SOURCE, sourcePeriod: month, rowsScanned: 1, employeesInSource: 1 });

  await repositories.leaveHr.transaction(async (tx) => {
    await tx.upsertEntitlement({ employeeUid: uid, fiscalYearBe: 2569, leaveType: 'sick', entitlementDays: 60, carryoverDays: null, usageBaselineDays: 4, usageBaselineThrough: '2025-12-31', sourceReference: 'test', importBatchUid: batchUid, verifiedByUid: operator });
    await tx.upsertEntitlement({ employeeUid: uid, fiscalYearBe: 2569, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 3, usageBaselineDays: null, usageBaselineThrough: null, sourceReference: 'test', importBatchUid: batchUid, verifiedByUid: operator });
  });

  const service = createLeaveService({ repositories, config: { leave: { entitlementEngine: 'on' } } });
  const auth = { employeeUid: uid, role: 'user' };

  await t.test('numbers come from the HR rows and the records, deducted once', async () => {
    const rows = Object.fromEntries((await service.balance(auth, uid, 2569, { basis: 'fiscal' })).map((r) => [r.leaveType, r]));
    // sick: 4 (baseline) + 2026-02-02; 2025-11-03 is inside the baseline; 2026-02-03 is not approved
    assert.deepEqual([rows.sick.source, rows.sick.totalDays, rows.sick.usedDays, rows.sick.remainingDays, rows.sick.usageComplete], ['hr_verified', 60, 5, 55, true]);
    assert.deepEqual(rows.sick.flags.map((f) => f.code), ['records_before_baseline_ignored', 'policy_pending_hr_verified']);
    // vacation: 10 + 3 carried, one half day before the announcement took effect, counted as recorded and not flagged
    assert.deepEqual([rows.vacation.totalDays, rows.vacation.usedDays, rows.vacation.remainingDays], [13, 0.5, 12.5]);
    assert.equal(rows.vacation.flags.some((f) => f.code === 'vacation_half_day_review'), false);
    assert.equal(rows.sick.pendingDays, 1);
    // no HR row for personal and the year starts before the policy: no number
    assert.deepEqual([rows.personal.status, rows.personal.totalDays], ['pending_policy', null]);
  });

  await t.test('a month missing from the coverage table withholds the balance', async () => {
    await pool.query('DELETE FROM employee_leave_record_coverage WHERE source_system = ? AND source_period = ?', [SOURCE, '2026-06']);
    const sick = (await service.balance(auth, uid, 2569, { basis: 'fiscal' })).find((r) => r.leaveType === 'sick');
    assert.deepEqual([sick.usageComplete, sick.remainingDays, sick.available], [false, null, false]);
    assert.deepEqual(sick.uncoveredMonths, ['2026-06']);
  });

  await t.test('RBAC is the existing one, the flag gates the feature and the calendar path is untouched', async () => {
    await assert.rejects(() => service.balance({ employeeUid: other, role: 'user' }, uid, 2569, { basis: 'fiscal' }), (e) => e.status === 403);
    const off = createLeaveService({ repositories, config: { leave: { entitlementEngine: 'off' } } });
    await assert.rejects(() => off.balance(auth, uid, 2569, { basis: 'fiscal' }), (e) => e.status === 503);
    const calendar = await off.balance(auth, uid, 2026);
    assert.ok(calendar.every((row) => row.basis === undefined && row.status === undefined)); // legacy rows have no new fields
  });
});
