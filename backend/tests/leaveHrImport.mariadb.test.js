/**
 * The HR import tool end to end against the REAL schema (034-036): apply, field audit, idempotency by file hash,
 * and a database-level rollback. Skipped wherever no database is present.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID, randomInt } = require('node:crypto');

const { isDatabaseConfigured, createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { runLeaveHrImport } = require('../src/imports/leaveHrImportCli');
const { PROFILE_COLUMNS: P, ENTITLEMENT_COLUMNS: E } = require('../src/domain/hrLeaveCsv');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

test('HR import on MariaDB: apply, audit, idempotency and rollback', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-leave-db-'));

  async function freeId() {
    for (;;) {
      const id = String(randomInt(1000, 9999));
      const [rows] = await pool.query('SELECT 1 FROM employees WHERE employee_id = ?', [id]);
      if (rows.length === 0) return id;
    }
  }
  const make = async (type, role) => {
    const uid = randomUUID();
    const id = await freeId();
    await pool.query(
      `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, status, role, created_at, updated_at)
       VALUES (?, ?, 'ทดสอบ', 'นำเข้า', ?, 'test', ?, 'active', ?, NOW(), NOW())`,
      [uid, id, `${uid}@hr-import.test`, type, role],
    );
    return { uid, id };
  };
  const person = await make('university', 'user');
  const operator = await make('university', 'executive');
  await pool.query("INSERT INTO authorization_grants (employee_uid, role, scope_type, org_unit_code, created_at, updated_at) VALUES (?, 'EXECUTIVE', 'organization', NULL, NOW(), NOW())", [operator.uid]);
  const uids = [person.uid, operator.uid];

  t.after(async () => {
    for (const [sql, params] of [
      ['DELETE FROM leave_hr_audit WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM leave_hr_import_batch WHERE operator_uid = ?', [operator.uid]],
      ['DELETE FROM employee_leave_entitlement WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM employee_leave_profile WHERE employee_uid IN (?)', [uids]],
      ['DELETE FROM authorization_grants WHERE employee_uid = ?', [operator.uid]],
      ['DELETE FROM employees WHERE employee_uid IN (?)', [uids]],
    ]) await pool.query(sql, params).catch(() => {});
    await closePool();
  });

  const write = (columns, row) => {
    const target = path.join(dir, `${randomUUID()}.csv`);
    fs.writeFileSync(target, `\uFEFF${Object.values(columns).join(',')}\r\n${row.join(',')}\r\n`);
    return target;
  };
  const profileFile = write(P, [person.id, '', '', '2015-04-01', '2015-04-01', '', '', '', `source ${randomUUID()}`, '']);
  const entitlementFile = write(E, [person.id, '2570', 'ลาพักผ่อน', '10', '4', '2', '2026-11-15', `source ${randomUUID()}`, '']);
  const args = (file, kind) => [`--${kind}`, file, '--confirm', '--operator', operator.uid];
  const container = (repos = repositories) => ({ dataSource: 'mariadb', repositories: repos });

  await t.test('a database-level failure rolls the whole import back', async () => {
    const real = repositories.leaveHr;
    const failing = { ...repositories, leaveHr: { ...real, transaction: (fn) => real.transaction(async (tx) => { await fn(tx); throw new Error('late failure'); }) } };
    await assert.rejects(() => runLeaveHrImport([...args(profileFile, 'profile'), '--entitlement', entitlementFile], { container: container(failing) }), /late failure/);
    const [[employee]] = await pool.query('SELECT hire_date FROM employees WHERE employee_uid = ?', [person.uid]);
    assert.equal(employee.hire_date, null);
    assert.equal(await real.getProfile(person.uid), null);
    assert.deepEqual(await real.listEntitlements(person.uid, 2570), []);
    const [batches] = await pool.query('SELECT 1 FROM leave_hr_import_batch WHERE operator_uid = ?', [operator.uid]);
    assert.equal(batches.length, 0);
  });

  await t.test('apply writes the facts, the batches and the audit', async () => {
    const { exitCode, report } = await runLeaveHrImport([...args(profileFile, 'profile'), '--entitlement', entitlementFile], { container: container() });
    assert.equal(exitCode, 0);
    assert.equal(report.written, true);
    const [[employee]] = await pool.query("SELECT DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire_date FROM employees WHERE employee_uid = ?", [person.uid]);
    assert.equal(employee.hire_date, '2015-04-01');
    const profile = await repositories.leaveHr.getProfile(person.uid);
    assert.deepEqual([profile.continuousServiceStart, profile.verifiedByUid], ['2015-04-01', operator.uid]);
    const row = await repositories.leaveHr.getEntitlement(person.uid, 2570, 'vacation');
    assert.deepEqual([row.entitlementDays, row.carryoverDays, row.usageBaselineDays, row.usageBaselineThrough], [10, 4, 2, '2026-11-15']);
    const [batches] = await pool.query('SELECT kind, rows_applied FROM leave_hr_import_batch WHERE operator_uid = ? ORDER BY kind', [operator.uid]);
    assert.deepEqual(batches.map((b) => [b.kind, b.rows_applied]).sort(), [['entitlement', 1], ['profile', 1]]);
    const [audit] = await pool.query('SELECT table_name, field_name FROM leave_hr_audit WHERE employee_uid = ? ORDER BY id', [person.uid]);
    assert.ok(audit.some((a) => a.table_name === 'employees' && a.field_name === 'hire_date'));
    assert.ok(audit.some((a) => a.table_name === 'employee_leave_entitlement' && a.field_name === 'carryover_days'));
  });

  await t.test('the same files again change nothing', async () => {
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM leave_hr_audit WHERE employee_uid = ?', [person.uid]);
    const { exitCode, report } = await runLeaveHrImport([...args(profileFile, 'profile'), '--entitlement', entitlementFile], { container: container() });
    assert.equal(exitCode, 0);
    assert.equal(report.alreadyApplied, true);
    assert.equal(report.written, false);
    const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM leave_hr_audit WHERE employee_uid = ?', [person.uid]);
    assert.equal(after.n, before.n);
  });
});
