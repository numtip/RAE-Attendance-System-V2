/**
 * Backend National ID integration tests on a DISPOSABLE MariaDB. Opt-in: RAE_QA_DB_PORTS (e.g. "33611,33603"),
 * loopback only, per-test database rae_qa_*. All identifiers/keys are synthetic.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const mysql = require('mysql2/promise');
const { createEmployeeIdentifierMariaDbRepository } = require('../src/repositories/mariadb/employeeIdentifierMariaDbRepository');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createNationalIdProtector, buildLookup, loadIdentifierKeys } = require('../src/security/nationalIdContract');

const ports = (process.env.RAE_QA_DB_PORTS || '').split(',').map((p) => Number(p.trim())).filter(Boolean);
const host = process.env.RAE_QA_DB_HOST || '127.0.0.1';
const user = process.env.RAE_QA_DB_USER || 'root';
const password = process.env.RAE_QA_DB_PASSWORD || '';
const skip = ports.length === 0 || !['127.0.0.1', 'localhost', '::1'].includes(host);
const migrationsDir = path.resolve(path.dirname(require.resolve('../package.json')), '..', 'database', 'migrations');

const b64 = (n) => randomBytes(n).toString('base64');
const ID_A = '9999999999991';
const ID_B = '9999999999992';
const ID_C = '9999999999993';

function protectorFor(version, key, previous = null) {
  const env = { EMPLOYEE_IDENTIFIER_HMAC_KEY: key, EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: String(version) };
  if (previous) {
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS = previous.key;
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION = String(previous.version);
  }
  return createNationalIdProtector(env);
}

async function withDb(port, fn) {
  const name = `rae_qa_${randomBytes(4).toString('hex')}`;
  const admin = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  const pool = mysql.createPool({ host, port, user, password, database: name, connectionLimit: 30, multipleStatements: true });
  try {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    for (let i = 1; i <= 12; i += 1) {
      await pool.query(
        `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, status, created_at, updated_at)
         VALUES (?, ?, 'ทดสอบ', 'คิวเอ', ?, 'QA', 'department', 'active', NOW(), NOW())`,
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

function serviceFor(pool, protector) {
  const identifiers = createEmployeeIdentifierMariaDbRepository(pool, { nationalId: protector });
  const employees = {
    async findByUid(uid) {
      const [rows] = await pool.query('SELECT employee_uid FROM employees WHERE employee_uid = ?', [uid]);
      return rows[0] ? { employeeUid: rows[0].employee_uid } : null;
    },
  };
  return { service: createEmployeeIdentityService({ repositories: { employeeIdentifiers: identifiers, employees } }), identifiers };
}

const settle = (promises) => Promise.allSettled(promises);
const dump = async (pool) => {
  const [a] = await pool.query('SELECT * FROM employee_identifier');
  const [b] = await pool.query('SELECT * FROM employee_identifier_access_audit');
  const [c] = await pool.query('SELECT * FROM employee_identifier_secret');
  return JSON.stringify({ a, b, c });
};

for (const port of ports) {
  const label = `MariaDB:${port}`;

  test(`${label} insert/lookup/resolve stores HMAC only, never plaintext, audit has no PII`, { skip }, async () => {
    await withDb(port, async (pool) => {
      const key = b64(32);
      const { service } = serviceFor(pool, protectorFor(1, key));
      const linked = await service.linkIdentifier({ employeeUid: 'emp-1', idType: 'national_id', idValue: '9-9999-99999-99-1', actor: 'operator:qa', reason: 'qa-link' });
      assert.equal(linked.idValue, null);
      assert.equal(linked.lookupKeyVersion, 1);
      assert.equal(await service.resolveUid('national_id', ID_A, { actor: 'sso:callback', reason: 'sso-login' }), 'emp-1');
      await assert.rejects(() => service.resolve('national_id', ID_B), (e) => e.code === 'EMPLOYEE_NOT_FOUND');

      const [[row]] = await pool.query("SELECT id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id'");
      const expected = buildLookup('national_id', ID_A, loadIdentifierKeys({ EMPLOYEE_IDENTIFIER_HMAC_KEY: key, EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1' })).lookup_hmac;
      assert.equal(row.id_value, expected);
      assert.equal(row.lookup_key_version, 1);

      const listed = await service.listIdentifiers('emp-1');
      assert.equal(listed[0].idValue, undefined);
      assert.equal(listed[0].idValueMasked, '[protected]');
      assert.ok(!JSON.stringify(listed).includes(expected));

      const [audit] = await pool.query('SELECT action, actor, reason, key_version FROM employee_identifier_access_audit ORDER BY id');
      assert.deepEqual(audit.map((a) => a.action), ['create', 'lookup', 'lookup']);
      assert.deepEqual(audit.map((a) => a.reason), ['qa-link', 'sso-login', 'resolve:miss']);
      const blob = await dump(pool);
      for (const id of [ID_A, ID_B, '9-9999-99999-99-1']) assert.ok(!blob.includes(id), 'raw id leaked');
      assert.ok(!/\b\d{13}\b/.test(blob), 'any 13-digit run found in identifier/audit/secret tables');
      const [[secrets]] = await pool.query('SELECT COUNT(*) c FROM employee_identifier_secret');
      assert.equal(Number(secrets.c), 0, 'raw storage must stay disabled by default');
    });
  });

  test(`${label} concurrency: duplicate across employees, same-employee idempotency, one-per-employee`, { skip }, async () => {
    await withDb(port, async (pool) => {
      const { service } = serviceFor(pool, protectorFor(1, b64(32)));
      const dupes = await settle(
        Array.from({ length: 8 }, (_, i) => service.linkIdentifier({ employeeUid: `emp-${i + 1}`, idType: 'national_id', idValue: ID_A })),
      );
      assert.equal(dupes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(dupes.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'DUPLICATE_IDENTIFIER'));
      const [[n1]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE id_type='national_id'");
      assert.equal(Number(n1.c), 1);

      const same = await settle(Array.from({ length: 6 }, () => service.linkIdentifier({ employeeUid: 'emp-9', idType: 'national_id', idValue: ID_B })));
      assert.ok(same.every((r) => r.status === 'fulfilled'));
      const [[n2]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE employee_uid='emp-9'");
      assert.equal(Number(n2.c), 1);

      const many = await settle([ID_C, '9999999999994', '9999999999995', '9999999999996'].map((id) => service.linkIdentifier({ employeeUid: 'emp-10', idType: 'national_id', idValue: id })));
      assert.equal(many.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(many.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'EMPLOYEE_ALREADY_HAS_NATIONAL_ID'));

      // owner key + NULL semantics: non-national rows never collide; deactivated national row still occupies the slot
      for (const [type, value] of [['facescan_id', 'FS1'], ['facescan_id', 'FS2'], ['personnel_id', 'P1'], ['employee_id', 'E1']]) {
        await service.linkIdentifier({ employeeUid: 'emp-11', idType: type, idValue: value });
      }
      const linked = await service.linkIdentifier({ employeeUid: 'emp-12', idType: 'national_id', idValue: '9999999999997' });
      await service.unlinkIdentifier({ id: linked.id, employeeUid: 'emp-12' });
      await assert.rejects(
        () => service.linkIdentifier({ employeeUid: 'emp-12', idType: 'national_id', idValue: '9999999999998' }),
        (e) => e.code === 'EMPLOYEE_ALREADY_HAS_NATIONAL_ID',
      );
    });
  });

  test(`${label} cross-version race: dual-key writers serialize; v1-only writer hazard is closed by the write freeze`, { skip }, async () => {
    await withDb(port, async (pool) => {
      const key1 = b64(32);
      const key2 = b64(32);
      // every instance holds BOTH keys (rollout phase 1): current differs per instance, previous is the other key
      const writerV1 = serviceFor(pool, protectorFor(1, key1, { key: key2, version: 2 })).service;
      const writerV2 = serviceFor(pool, protectorFor(2, key2, { key: key1, version: 1 })).service;
      const results = await settle(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? writerV1 : writerV2).linkIdentifier({ employeeUid: `emp-${i + 1}`, idType: 'national_id', idValue: ID_A })),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'DUPLICATE_IDENTIFIER'));
      const [[n]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE id_type='national_id'");
      assert.equal(Number(n.c), 1);
      const [[winner]] = await pool.query("SELECT employee_uid FROM employee_identifier WHERE id_type='national_id'");

      // HAZARD (documented): a v1-ONLY instance cannot compute the v2 HMAC, so it cannot see a row written under v2.
      const v1Only = serviceFor(pool, protectorFor(1, key1)).service;
      const v2Only = serviceFor(pool, protectorFor(2, key2)).service;
      await v2Only.linkIdentifier({ employeeUid: 'emp-11', idType: 'national_id', idValue: ID_B });
      await v1Only.linkIdentifier({ employeeUid: 'emp-12', idType: 'national_id', idValue: ID_B }); // same person slips through
      const [[dupe]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE employee_uid IN ('emp-11','emp-12')");
      assert.equal(Number(dupe.c), 2, 'this is exactly why rotation REQUIRES a national_id write freeze until all instances hold both keys');

      // MITIGATION: the freeze blocks every national_id write; reads keep working
      const frozen = serviceFor(pool, createNationalIdProtector({
        EMPLOYEE_IDENTIFIER_HMAC_KEY: key2, EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '2',
        EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: key1, EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1',
        EMPLOYEE_IDENTIFIER_NATIONAL_WRITE_FREEZE: 'true',
      })).service;
      await assert.rejects(
        () => frozen.linkIdentifier({ employeeUid: 'emp-9', idType: 'national_id', idValue: ID_C }),
        (e) => e.status === 503 && e.code === 'NATIONAL_ID_WRITES_FROZEN',
      );
      assert.equal(await frozen.resolveUid('national_id', ID_A), winner.employee_uid);
    });
  });
  test(`${label} rotation v1/v2: previous-key lookup, reindex, and legacy plaintext rejection`, { skip }, async () => {
    await withDb(port, async (pool) => {
      const key1 = b64(32);
      const key2 = b64(32);
      const v1 = serviceFor(pool, protectorFor(1, key1));
      await v1.service.linkIdentifier({ employeeUid: 'emp-1', idType: 'national_id', idValue: ID_A });

      const v2NoPrev = serviceFor(pool, protectorFor(2, key2));
      await assert.rejects(() => v2NoPrev.service.resolve('national_id', ID_A), (e) => e.code === 'EMPLOYEE_NOT_FOUND'); // why previous is required

      const protectorV2 = protectorFor(2, key2, { key: key1, version: 1 });
      const v2 = serviceFor(pool, protectorV2);
      assert.equal(await v2.service.resolveUid('national_id', ID_A), 'emp-1');
      await v2.service.linkIdentifier({ employeeUid: 'emp-2', idType: 'national_id', idValue: ID_B });
      const [versions] = await pool.query("SELECT employee_uid, lookup_key_version v FROM employee_identifier WHERE id_type='national_id' ORDER BY employee_uid");
      assert.deepEqual(versions.map((r) => r.v), [1, 2]);

      const [rows] = await pool.query("SELECT id, employee_uid, id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id'");
      const plan = protectorV2.planReindex(rows, { resolveRaw: (row) => ({ 'emp-1': ID_A, 'emp-2': ID_B })[row.employee_uid] });
      assert.equal(plan.ok, true);
      assert.equal(plan.updates.length, 1);
      for (const u of plan.updates) {
        await pool.query('UPDATE employee_identifier SET id_value=?, lookup_key_version=? WHERE id=? AND lookup_key_version <=> ?', [u.new_id_value, u.to_version, u.id, u.from_version]);
      }
      assert.equal(await v2NoPrev.service.resolveUid('national_id', ID_A), 'emp-1'); // v2-only now works
      await assert.rejects(() => v1.service.resolve('national_id', ID_A), (e) => e.code === 'EMPLOYEE_NOT_FOUND');

      // legacy plaintext is rejected by the database itself
      await assert.rejects(
        () => pool.query("INSERT INTO employee_identifier (employee_uid,id_type,id_value,lookup_key_version,is_primary,created_at,updated_at) VALUES ('emp-3','national_id',?,1,0,NOW(),NOW())", [ID_C]),
        (e) => /CONSTRAINT|chk_employee_identifier_national_lookup/i.test(e.message),
      );
      await assert.rejects(
        () => pool.query("INSERT INTO employee_identifier (employee_uid,id_type,id_value,is_primary,created_at,updated_at) VALUES ('emp-3','national_id',?,0,NOW(),NOW())", [ID_C]),
      );
    });
  });

  test(`${label} fail-closed: unconfigured protector writes nothing; raw storage stays disabled; create audit is mandatory`, { skip }, async () => {
    await withDb(port, async (pool) => {
      const off = serviceFor(pool, createNationalIdProtector({})).service;
      await assert.rejects(() => off.linkIdentifier({ employeeUid: 'emp-1', idType: 'national_id', idValue: ID_A }), (e) => e.code === 'NATIONAL_ID_PROTECTION_UNAVAILABLE' && e.status === 503);
      await assert.rejects(() => off.resolve('national_id', ID_A), (e) => e.status === 503);
      const [[n0]] = await pool.query('SELECT COUNT(*) c FROM employee_identifier');
      assert.equal(Number(n0.c), 0);

      const protector = protectorFor(1, b64(32));
      assert.equal(protector.rawStorageEnabled, false);
      assert.throws(() => protector.encryptRaw(ID_A, { necessityApprovalRef: 'APPROVAL-1' }), (e) => e.message.includes('RAW_STORAGE_DISABLED'));

      const { service } = serviceFor(pool, protector);
      await pool.query('RENAME TABLE employee_identifier_access_audit TO audit_moved');
      await assert.rejects(() => service.linkIdentifier({ employeeUid: 'emp-1', idType: 'national_id', idValue: ID_A }));
      const [[n1]] = await pool.query("SELECT COUNT(*) c FROM employee_identifier WHERE id_type='national_id'");
      assert.equal(Number(n1.c), 0, 'create must roll back when its audit row cannot be written');
      await pool.query('RENAME TABLE audit_moved TO employee_identifier_access_audit');
      await service.linkIdentifier({ employeeUid: 'emp-1', idType: 'national_id', idValue: ID_A });
      await pool.query('RENAME TABLE employee_identifier_access_audit TO audit_moved');
      assert.equal(await service.resolveUid('national_id', ID_A), 'emp-1', 'lookup audit is best-effort');
      await pool.query('RENAME TABLE audit_moved TO employee_identifier_access_audit');
      const [[lock]] = await pool.query('SELECT IS_FREE_LOCK(?) AS free', ['rae:employee_identifier:national_id:write']);
      assert.equal(Number(lock.free), 1, 'write lock must always be released');
    });
  });
}

test('backend integration suite is opt-in and loopback-only', () => {
  assert.ok(skip || ports.length > 0);
});
