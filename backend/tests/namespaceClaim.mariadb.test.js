/**
 * Migration 017 (namespace claim) on a DISPOSABLE MariaDB. Opt-in: RAE_QA_DB_PORTS, loopback only, rae_qa_* databases.
 * Proves: DB-level collision refusal for every writer, atomicity under concurrency, UPDATE/DELETE claim lifecycle,
 * backfill, preflight abort, idempotent rerun and rollback. All identifiers are synthetic.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const mysql = require('mysql2/promise');
const { createEmployeeIdentifierMariaDbRepository } = require('../src/repositories/mariadb/employeeIdentifierMariaDbRepository');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createNationalIdProtector } = require('../src/security/nationalIdContract');

const ports = (process.env.RAE_QA_DB_PORTS || '').split(',').map((p) => Number(p.trim())).filter(Boolean);
const host = process.env.RAE_QA_DB_HOST || '127.0.0.1';
const user = process.env.RAE_QA_DB_USER || 'root';
const password = process.env.RAE_QA_DB_PASSWORD || '';
const skip = ports.length === 0 || !['127.0.0.1', 'localhost', '::1'].includes(host);
const root = path.resolve(path.dirname(require.resolve('../package.json')), '..', 'database');
const migrationsDir = path.join(root, 'migrations');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const M017 = '017_identifier_namespace_claim.sql';

async function withDb(port, { upTo = null, employees = 12 } = {}, fn) {
  const name = `rae_qa_${randomBytes(4).toString('hex')}`;
  const admin = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  const pool = mysql.createPool({ host, port, user, password, database: name, connectionLimit: 40, multipleStatements: true });
  try {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => (upTo === null ? true : f < upTo));
    for (const file of files) await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    for (let i = 1; i <= employees; i += 1) {
      await pool.query(
        `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, status, created_at, updated_at)
         VALUES (?, ?, 'ทดสอบ', 'คิวเอ', ?, 'QA', 'contract', 'active', NOW(), NOW())`,
        [`emp-${i}`, `QA-${i}`, `emp${i}@example.test`],
      );
    }
    await fn(pool, name);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  }
}

const raw = (pool, uid, type, value) => pool.query(
  `INSERT INTO employee_identifier (employee_uid, id_type, id_value, source_system, status, created_at, updated_at)
   VALUES (?, ?, ?, 'qa', 'active', NOW(), NOW())`,
  [uid, type, value],
);
const isCollision = (error) => error && error.sqlState === '45000' && /IDENTIFIER_NAMESPACE_COLLISION/.test(error.sqlMessage || error.message);
const preflight = async (pool) => {
  const [result] = await pool.query(read('preflight', '017_preflight.sql'));
  const first = Array.isArray(result[0]) ? result[0] : result;
  return first[0];
};
const claims = async (pool) => (await pool.query('SELECT claim_value, employee_uid FROM employee_identifier_namespace_claim ORDER BY claim_value'))[0];

for (const port of ports) {
  const label = `MariaDB:${port}`;

  test(`${label} 017: any writer is refused when another employee owns the same facescan/personnel text`, { skip }, async () => {
    await withDb(port, {}, async (pool) => {
      await raw(pool, 'emp-1', 'facescan_id', '5001');
      await assert.rejects(() => raw(pool, 'emp-2', 'personnel_id', '5001'), isCollision);
      await assert.rejects(() => raw(pool, 'emp-2', 'personnel_id', '5001 '), isCollision, 'collation-equal text collides too');
      // rejected statement leaves nothing behind
      const [[count]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE employee_uid='emp-2'");
      assert.equal(Number(count.c), 0);
      // same employee may hold equal text in both types; reverse direction is also protected
      await raw(pool, 'emp-1', 'personnel_id', '5001');
      await raw(pool, 'emp-3', 'personnel_id', '6001');
      await assert.rejects(() => raw(pool, 'emp-4', 'facescan_id', '6001'), isCollision);
      // same (type,value) on two employees still hits the original unique key
      await assert.rejects(() => raw(pool, 'emp-5', 'facescan_id', '5001'), (e) => e.code === 'ER_DUP_ENTRY' || isCollision(e));
      // other id types are not claimed
      await raw(pool, 'emp-6', 'employee_id', '5001');
      assert.deepEqual((await claims(pool)).map((c) => [c.claim_value, c.employee_uid]), [['5001', 'emp-1'], ['6001', 'emp-3']]);
    });
  });

  test(`${label} 017: concurrent claims of one value across both types leave exactly one owner`, { skip }, async () => {
    await withDb(port, {}, async (pool) => {
      for (let round = 0; round < 6; round += 1) {
        const value = `C${round}-777`;
        const attempts = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => raw(pool, `emp-${n}`, n % 2 ? 'facescan_id' : 'personnel_id', value));
        const results = await Promise.allSettled(attempts);
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        assert.ok(ok <= 1, 'at most one writer may win');
        const [owners] = await pool.query(
          "SELECT DISTINCT employee_uid FROM employee_identifier WHERE id_value = ? AND id_type IN ('facescan_id','personnel_id')", [value]);
        assert.ok(owners.length <= 1, `round ${round}: more than one owner for one value`);
        const [held] = await pool.query('SELECT employee_uid FROM employee_identifier_namespace_claim WHERE claim_value = ?', [value]);
        assert.deepEqual(held.map((r) => r.employee_uid), owners.map((r) => r.employee_uid));
        const bad = results.filter((r) => r.status === 'rejected').map((r) => r.reason).filter((e) => !(isCollision(e) || e.code === 'ER_DUP_ENTRY' || e.errno === 1213)); // 1213 = safe deadlock victim (rolled back)
        assert.deepEqual(bad.map((e) => [e.code, e.errno, String(e.sqlMessage).slice(0, 80)]), [], 'unexpected failure kind');
      }
    });
  });

  test(`${label} 017: service-level race returns 409 for the losers and one winner`, { skip }, async () => {
    await withDb(port, {}, async (pool) => {
      const protector = createNationalIdProtector({ EMPLOYEE_IDENTIFIER_HMAC_KEY: randomBytes(32).toString('base64'), EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1' });
      const identifiers = createEmployeeIdentifierMariaDbRepository(pool, { nationalId: protector });
      const employees = { async findByUid(uid) { const [r] = await pool.query('SELECT employee_uid FROM employees WHERE employee_uid=?', [uid]); return r[0] ? { employeeUid: uid } : null; } };
      const service = createEmployeeIdentityService({ repositories: { employeeIdentifiers: identifiers, employees } });
      const tasks = [];
      for (let n = 1; n <= 10; n += 1) {
        tasks.push(n % 2
          ? service.linkIdentifier({ employeeUid: `emp-${n}`, idType: 'facescan_id', idValue: '9100', sourceSystem: 'IDCardRaecsv2027' })
          : service.linkIdentifier({ employeeUid: `emp-${n}`, idType: 'personnel_id', idValue: '9100', sourceSystem: 'mju_person_api' }));
      }
      const results = await Promise.allSettled(tasks);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409
        && ['IDENTIFIER_NAMESPACE_COLLISION', 'DUPLICATE_IDENTIFIER'].includes(r.reason.code)));
      const [owners] = await pool.query("SELECT DISTINCT employee_uid FROM employee_identifier WHERE id_value='9100'");
      assert.equal(owners.length, 1);
    });
  });

  test(`${label} 017: UPDATE and DELETE keep claims consistent`, { skip }, async () => {
    await withDb(port, {}, async (pool) => {
      await raw(pool, 'emp-1', 'facescan_id', '7001');
      await raw(pool, 'emp-2', 'facescan_id', '7002');
      // moving a value onto another employee's claim is refused and rolled back
      await assert.rejects(() => pool.query("UPDATE employee_identifier SET id_value='7002' WHERE employee_uid='emp-1' AND id_value='7001'"), (e) => isCollision(e) || e.code === 'ER_DUP_ENTRY');
      await assert.rejects(() => pool.query("UPDATE employee_identifier SET id_type='personnel_id', id_value='7002' WHERE employee_uid='emp-1'"), isCollision);
      assert.deepEqual((await claims(pool)).map((c) => c.claim_value), ['7001', '7002']);
      // free rename releases the old claim and takes the new one
      await pool.query("UPDATE employee_identifier SET id_value='7003' WHERE employee_uid='emp-1' AND id_value='7001'");
      assert.deepEqual((await claims(pool)).map((c) => [c.claim_value, c.employee_uid]), [['7002', 'emp-2'], ['7003', 'emp-1']]);
      await raw(pool, 'emp-3', 'personnel_id', '7001'); // 7001 is free again
      // status changes do not touch claims (deactivated rows still occupy the value, like UNIQUE(type,value))
      await pool.query("UPDATE employee_identifier SET status='inactive' WHERE employee_uid='emp-2'");
      await assert.rejects(() => raw(pool, 'emp-4', 'personnel_id', '7002'), isCollision);
      // delete releases the claim only when no sibling row keeps the value
      await raw(pool, 'emp-2', 'personnel_id', '7002');
      await pool.query("DELETE FROM employee_identifier WHERE employee_uid='emp-2' AND id_type='facescan_id'");
      assert.ok((await claims(pool)).some((c) => c.claim_value === '7002'), 'sibling personnel_id row still holds the claim');
      await pool.query("DELETE FROM employee_identifier WHERE employee_uid='emp-2'");
      assert.ok(!(await claims(pool)).some((c) => c.claim_value === '7002'));
      await raw(pool, 'emp-4', 'personnel_id', '7002');
    });
  });

  test(`${label} 017: backfill, idempotent rerun, preflight abort and rollback`, { skip }, async () => {
    // backfill + idempotent rerun
    await withDb(port, { upTo: M017 }, async (pool) => {
      await raw(pool, 'emp-1', 'facescan_id', '8001');
      await raw(pool, 'emp-1', 'personnel_id', '8001'); // same employee, both namespaces: fine
      await raw(pool, 'emp-2', 'personnel_id', '8002');
      await pool.query(read('migrations', M017));
      await pool.query(read('migrations', M017)); // rerun is safe
      assert.deepEqual((await claims(pool)).map((c) => [c.claim_value, c.employee_uid]), [['8001', 'emp-1'], ['8002', 'emp-2']]);
      const [[triggers]] = await pool.query("SELECT COUNT(*) c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_employee_identifier_ns_%'");
      assert.equal(Number(triggers.c), 3);
      const pre = await preflight(pool);
      assert.equal(Number(pre.cross_employee_namespace_collisions), 0);
      assert.equal(pre.id_value_collation, 'utf8mb4_unicode_ci');
      await assert.rejects(() => raw(pool, 'emp-3', 'facescan_id', '8002'), isCollision);

      // rollback removes triggers + derived table, rows untouched, collisions possible again
      await pool.query(read('rollbacks', '017_identifier_namespace_claim.down.sql'));
      const [[after]] = await pool.query("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_namespace_claim'");
      assert.equal(Number(after.c), 0);
      const [[rows]] = await pool.query('SELECT COUNT(*) c FROM employee_identifier');
      assert.equal(Number(rows.c), 3);
      await raw(pool, 'emp-3', 'facescan_id', '8002');
      // re-applying while a collision exists must abort before creating anything
      const flag = await preflight(pool);
      assert.equal(Number(flag.cross_employee_namespace_collisions), 1);
      await assert.rejects(() => pool.query(read('migrations', M017)), /ABORT_017_cross_employee_namespace_collisions_exist/);
      const [[none]] = await pool.query("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_namespace_claim'");
      assert.equal(Number(none.c), 0, 'abort must happen before DDL');
      const [[trg]] = await pool.query("SELECT COUNT(*) c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_employee_identifier_ns_%'");
      assert.equal(Number(trg.c), 0);
    });
  });
}

test('namespace claim suite is opt-in and loopback-only', () => {
  assert.ok(skip || ports.length > 0);
});
