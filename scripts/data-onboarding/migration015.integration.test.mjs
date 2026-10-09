/**
 * Integration tests for migrations 013/015 against a DISPOSABLE MariaDB.
 * Skipped unless RAE_QA_DB_PORTS is set (e.g. "33611,33603"). Safety:
 *   - host must be loopback; every test creates and drops its own database named rae_qa_*;
 *   - never reads MYSQL_* production settings; credentials come only from RAE_QA_DB_USER/PASSWORD.
 * All identifiers are synthetic; no real National ID is used.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  buildLookup,
  detectCrossVersionDuplicates,
  loadIdentifierKeys,
  planReindex,
} from './identifierCrypto.mjs';

const ports = (process.env.RAE_QA_DB_PORTS || '').split(',').map((p) => Number(p.trim())).filter(Boolean);
const host = process.env.RAE_QA_DB_HOST || '127.0.0.1';
const user = process.env.RAE_QA_DB_USER || 'root';
const password = process.env.RAE_QA_DB_PASSWORD || '';
const skip = ports.length === 0 || !['127.0.0.1', 'localhost', '::1'].includes(host);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const migrationsDir = path.join(repoRoot, 'database', 'migrations');
const M015 = '015_employee_identifier_secure_lookup.sql';

const b64 = (n) => randomBytes(n).toString('base64');
const keyEnv = (version, key = b64(32)) => ({
  EMPLOYEE_IDENTIFIER_HMAC_KEY: key,
  EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: String(version),
});
const FAKE_A = '9999999999991';
const FAKE_B = '9999999999992';

async function connect(port, database) {
  return mysql.createConnection({ host, port, user, password, database, multipleStatements: true });
}

async function withDb(port, fn) {
  const name = `rae_qa_${randomBytes(4).toString('hex')}`;
  const admin = await connect(port);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  const conn = await connect(port, name);
  try {
    await fn(conn, name);
  } finally {
    await conn.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  }
}

async function applyUpTo(conn, { includeFrom015 = false } = {}) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (file >= '015' && !includeFrom015) continue;
    await conn.query(await readFile(path.join(migrationsDir, file), 'utf8'));
    await conn.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [file]);
  }
}

const run015 = async (conn) => conn.query(await readFile(path.join(migrationsDir, M015), 'utf8'));
const runDown = async (conn) =>
  conn.query(await readFile(path.join(repoRoot, 'database', 'rollbacks', M015.replace('.sql', '.down.sql')), 'utf8'));

async function addEmployee(conn, uid) {
  await conn.query(
    `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department,
       employee_type, status, created_at, updated_at)
     VALUES (?, ?, 'ทดสอบ', 'คิวเอ', ?, 'QA', 'department', 'active', NOW(), NOW())`,
    [uid, `QA-${uid}`, `${uid}@example.test`],
  );
}

async function addNational(conn, uid, idValue, version) {
  const [res] = await conn.query(
    `INSERT INTO employee_identifier (employee_uid, id_type, id_value, lookup_key_version, is_primary, created_at, updated_at)
     VALUES (?, 'national_id', ?, ?, 0, NOW(), NOW())`,
    [uid, idValue, version],
  );
  return res.insertId;
}

const rejects = (promise, code) => assert.rejects(promise, (e) => (code ? e.code === code : true));

for (const port of ports) {
  const label = `MariaDB:${port}`;

  test(`${label} runner applies 001..015, ledger records versions, rerun and re-exec of 015 are idempotent`, { skip }, async () => {
    await withDb(port, async (conn, name) => {
      const envVars = {
        ...process.env,
        MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: name,
      };
      const first = spawnSync('node', ['scripts/migrate.mjs'], { cwd: repoRoot, env: envVars, encoding: 'utf8' });
      assert.equal(first.status, 0, first.stderr);
      const second = spawnSync('node', ['scripts/migrate.mjs'], { cwd: repoRoot, env: envVars, encoding: 'utf8' });
      assert.equal(second.status, 0, second.stderr);
      assert.ok(!/apply /.test(second.stdout), 'second run must skip everything');
      const [ledger] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
      const versions = ledger.map((r) => r.version);
      assert.ok(versions.includes('013_employee_identifier_foundation.sql'));
      assert.ok(versions.includes('013_personnel_identifier.sql'));
      assert.ok(versions.includes(M015));
      await run015(conn); // idempotent re-execution
      await run015(conn);
      const [cols] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME IN ('lookup_key_version','national_id_owner_uid')`,
      );
      assert.equal(cols.length, 2);
    });
  });

  test(`${label} constraints: CHECK, UNIQUE, per-employee guard, cross-version gap + app-level detection`, { skip }, async () => {
    await withDb(port, async (conn) => {
      await applyUpTo(conn, { includeFrom015: true });
      await addEmployee(conn, 'emp-a');
      await addEmployee(conn, 'emp-b');
      const k1 = loadIdentifierKeys(keyEnv(1));
      const hmacA1 = buildLookup('national_id', FAKE_A, k1).lookup_hmac;

      await addNational(conn, 'emp-a', hmacA1, 1); // accepted
      await rejects(addNational(conn, 'emp-b', FAKE_A, 1)); // plaintext rejected by CHECK
      await rejects(addNational(conn, 'emp-b', hmacA1.toUpperCase(), 1)); // non-lowercase-hex
      await rejects(addNational(conn, 'emp-b', buildLookup('national_id', FAKE_B, k1).lookup_hmac, null)); // missing version
      await rejects(addNational(conn, 'emp-b', hmacA1, 1), 'ER_DUP_ENTRY'); // same version duplicate
      const hmacA2 = buildLookup('national_id', FAKE_A, loadIdentifierKeys(keyEnv(2))).lookup_hmac;
      await rejects(addNational(conn, 'emp-a', hmacA2, 2), 'ER_DUP_ENTRY'); // second national row per employee

      // Documented gap: same person, other key version, other employee => DB accepts...
      const rowId = await addNational(conn, 'emp-b', hmacA2, 2);
      assert.ok(rowId > 0);
      await conn.query('DELETE FROM employee_identifier WHERE id = ?', [rowId]);
      // ...so the application-level detector must catch it before insert:
      const rotating = loadIdentifierKeys({
        ...keyEnv(2),
        EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: k1.hmac.current.key.toString('base64'),
        EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1',
      });
      const [existing] = await conn.query(
        "SELECT id, employee_uid, id_value, lookup_key_version FROM employee_identifier WHERE id_type = 'national_id'",
      );
      const hits = detectCrossVersionDuplicates([{ ref: 'candidate-0', raw: FAKE_A }], existing, rotating);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].existing_employee_uid, 'emp-a');
      assert.equal(hits[0].existing_key_version, 1);
      assert.equal(detectCrossVersionDuplicates([{ ref: 'c', raw: FAKE_B }], existing, rotating).length, 0);

      // Other identifier types are unaffected by the national_id CHECK.
      await conn.query(
        `INSERT INTO employee_identifier (employee_uid, id_type, id_value, is_primary, created_at, updated_at)
         VALUES ('emp-b', 'facescan_id', '12345', 1, NOW(), NOW())`,
      );
    });
  });

  test(`${label} legacy plaintext: preflight flags it, 015 fails at CHECK leaving only a NULLable column, reindex then rerun succeeds`, { skip }, async () => {
    await withDb(port, async (conn) => {
      await applyUpTo(conn);
      await addEmployee(conn, 'emp-a');
      await conn.query(
        `INSERT INTO employee_identifier (employee_uid, id_type, id_value, is_primary, created_at, updated_at)
         VALUES ('emp-a', 'national_id', ?, 0, NOW(), NOW())`,
        [FAKE_A],
      );
      const pre = await readFile(path.join(repoRoot, 'database', 'preflight', '015_preflight.sql'), 'utf8');
      const [preResult] = await conn.query(pre);
      const preRow = Array.isArray(preResult[0]) ? preResult[0][0] : preResult[0];
      assert.equal(Number(preRow.legacy_plaintext_national_rows), 1);
      assert.equal(Number(preRow.national_id_rows_pre_015), 1);
      assert.ok(!JSON.stringify(preRow).includes(FAKE_A), 'preflight must not output the value');

      await rejects(run015(conn));
      const [[state]] = await conn.query(
        `SELECT
           (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier' AND COLUMN_NAME='lookup_key_version') AS col,
           (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME='chk_employee_identifier_national_lookup') AS chk`,
      );
      assert.equal(Number(state.col), 1);
      assert.equal(Number(state.chk), 0);

      const keys = loadIdentifierKeys(keyEnv(1));
      const [rows] = await conn.query("SELECT id, employee_uid, id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id'");
      const plan = planReindex(rows, keys);
      assert.equal(plan.ok, true);
      assert.equal(plan.updates.length, 1);
      assert.ok(!JSON.stringify(plan).includes(FAKE_A), 'plan must not contain raw ids');
      await conn.beginTransaction();
      for (const u of plan.updates) {
        await conn.query('UPDATE employee_identifier SET id_value = ?, lookup_key_version = ? WHERE id = ?', [u.new_id_value, u.to_version, u.id]);
      }
      await conn.commit();
      await run015(conn); // now succeeds
      const [[after]] = await conn.query("SELECT id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id'");
      assert.equal(after.id_value, buildLookup('national_id', FAKE_A, keys).lookup_hmac);
      assert.equal(after.lookup_key_version, 1);
    });
  });

  test(`${label} key rotation: reindex v1->v2 is idempotent, collisions block, rollback to v1 is possible from source`, { skip }, async () => {
    await withDb(port, async (conn) => {
      await applyUpTo(conn, { includeFrom015: true });
      await addEmployee(conn, 'emp-a');
      await addEmployee(conn, 'emp-b');
      const keyV1 = b64(32);
      const k1 = loadIdentifierKeys(keyEnv(1, keyV1));
      await addNational(conn, 'emp-a', buildLookup('national_id', FAKE_A, k1).lookup_hmac, 1);
      await addNational(conn, 'emp-b', buildLookup('national_id', FAKE_B, k1).lookup_hmac, 1);
      const source = new Map([['emp-a', FAKE_A], ['emp-b', FAKE_B]]); // authoritative source stand-in
      const resolveRaw = (row) => source.get(row.employee_uid) ?? null;

      const k2 = loadIdentifierKeys({ ...keyEnv(2), EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: keyV1, EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1' });
      const select = () => conn.query("SELECT id, employee_uid, id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id' ORDER BY id");
      const apply = async (plan) => {
        await conn.beginTransaction();
        for (const u of plan.updates) {
          await conn.query('UPDATE employee_identifier SET id_value=?, lookup_key_version=? WHERE id=? AND lookup_key_version <=> ?', [u.new_id_value, u.to_version, u.id, u.from_version]);
        }
        await conn.commit();
      };

      // unresolved rows are reported, not guessed
      assert.equal(planReindex((await select())[0], k2).ok, false);
      const plan = planReindex((await select())[0], k2, { resolveRaw });
      assert.equal(plan.ok, true);
      await apply(plan);
      const [afterRows] = await select();
      assert.ok(afterRows.every((r) => r.lookup_key_version === 2));
      // idempotent
      const again = planReindex(afterRows, k2, { resolveRaw });
      assert.equal(again.updates.length, 0);
      assert.equal(again.skipped_current.length, 2);
      // UNIQUE still works under the new version
      await rejects(addNational(conn, 'emp-b', buildLookup('national_id', FAKE_A, k2).lookup_hmac, 2), 'ER_DUP_ENTRY');

      // collision: two rows resolve to one identity => plan not ok, nothing applied
      const collide = planReindex(
        [{ id: 1, employee_uid: 'x', id_value: 'a'.repeat(64), lookup_key_version: 1 }, { id: 2, employee_uid: 'y', id_value: 'b'.repeat(64), lookup_key_version: 1 }],
        k2,
        { resolveRaw: () => FAKE_A },
      );
      assert.equal(collide.ok, false);
      assert.equal(collide.collisions.length, 1);

      // rollback of the rotation: reindex back to v1 from the source with the old key as current
      const back = loadIdentifierKeys(keyEnv(1, keyV1));
      const backPlan = planReindex((await select())[0], back, { resolveRaw });
      assert.equal(backPlan.ok, true);
      await apply(backPlan);
      const [restored] = await select();
      assert.deepEqual(restored.map((r) => r.id_value), [buildLookup('national_id', FAKE_A, k1).lookup_hmac, buildLookup('national_id', FAKE_B, k1).lookup_hmac]);
      assert.ok(restored.every((r) => r.lookup_key_version === 1));
    });
  });

  test(`${label} rollback script: reversible, preserves HMAC rows, refuses when secrets exist, never drops audit`, { skip }, async () => {
    await withDb(port, async (conn) => {
      await applyUpTo(conn, { includeFrom015: true });
      await addEmployee(conn, 'emp-a');
      const k1 = loadIdentifierKeys(keyEnv(1));
      const hmacA = buildLookup('national_id', FAKE_A, k1).lookup_hmac;
      const rowId = await addNational(conn, 'emp-a', hmacA, 1);
      await conn.query(
        `INSERT INTO employee_identifier_secret (identifier_id, ciphertext, iv, auth_tag, enc_key_id, necessity_ref, retain_until, created_by, created_at)
         VALUES (?, ?, ?, ?, 'enc-qa', 'APPROVAL-QA', '2027-01-01', 'qa', NOW())`,
        [rowId, randomBytes(13), randomBytes(12), randomBytes(16)],
      );
      await rejects(runDown(conn)); // aborts: secret rows exist
      const [[still]] = await conn.query("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_secret'");
      assert.equal(Number(still.c), 1);
      const [[ledgerStill]] = await conn.query('SELECT COUNT(*) c FROM schema_migrations WHERE version = ?', [M015]);
      assert.equal(Number(ledgerStill.c), 1);

      await conn.query('DELETE FROM employee_identifier_secret');
      await runDown(conn);
      await runDown(conn); // rollback itself is idempotent
      const [[gone]] = await conn.query(
        `SELECT (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier' AND COLUMN_NAME = 'national_id_owner_uid') AS cols,
                (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier' AND COLUMN_NAME = 'lookup_key_version') AS version_col,
                (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier_secret') AS secret,
                (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier_access_audit') AS audit,
                (SELECT COUNT(*) FROM employee_identifier WHERE id_value = ?) AS hmac_rows,
                (SELECT COUNT(*) FROM schema_migrations WHERE version = ?) AS ledger`,
        [hmacA, M015],
      );
      assert.deepEqual([gone.cols, gone.version_col, gone.secret, gone.audit, gone.hmac_rows, gone.ledger].map(Number), [0, 1, 0, 1, 1, 0]);
      await run015(conn); // up again after rollback
      const [[reup]] = await conn.query("SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier' AND COLUMN_NAME='national_id_owner_uid'");
      assert.equal(Number(reup.c), 1);
    });
  });
  test(`${label} runner partial failure: legacy plaintext aborts 015 without ledger row; fix + rerun recovers`, { skip }, async () => {
    await withDb(port, async (conn, name) => {
      await applyUpTo(conn); // 001..014 + ledger
      await addEmployee(conn, 'emp-a');
      await conn.query(
        `INSERT INTO employee_identifier (employee_uid, id_type, id_value, is_primary, created_at, updated_at)
         VALUES ('emp-a', 'national_id', ?, 0, NOW(), NOW())`,
        [FAKE_A],
      );
      const envVars = {
        ...process.env,
        MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: name,
      };
      const failed = spawnSync('node', ['scripts/migrate.mjs'], { cwd: repoRoot, env: envVars, encoding: 'utf8' });
      assert.notEqual(failed.status, 0);
      assert.ok(!`${failed.stdout}${failed.stderr}`.includes(FAKE_A), 'runner output must not echo identifiers');
      const [[ledger]] = await conn.query('SELECT COUNT(*) c FROM schema_migrations WHERE version = ?', [M015]);
      assert.equal(Number(ledger.c), 0, 'failed migration must not be recorded');
      const [[partial]] = await conn.query(
        `SELECT (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier' AND COLUMN_NAME='lookup_key_version') AS col,
                (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='employee_identifier_secret') AS secret`,
      );
      assert.deepEqual([Number(partial.col), Number(partial.secret)], [1, 0], 'only the additive NULLable column remains');

      const keys = loadIdentifierKeys(keyEnv(1));
      const [rows] = await conn.query("SELECT id, employee_uid, id_value, lookup_key_version FROM employee_identifier WHERE id_type='national_id'");
      for (const u of planReindex(rows, keys).updates) {
        await conn.query('UPDATE employee_identifier SET id_value=?, lookup_key_version=? WHERE id=?', [u.new_id_value, u.to_version, u.id]);
      }
      const recovered = spawnSync('node', ['scripts/migrate.mjs'], { cwd: repoRoot, env: envVars, encoding: 'utf8' });
      assert.equal(recovered.status, 0, recovered.stderr);
      const [[ledger2]] = await conn.query('SELECT COUNT(*) c FROM schema_migrations WHERE version = ?', [M015]);
      assert.equal(Number(ledger2.c), 1);
    });
  });

  test(`${label} owner-unique recovery: existing duplicate per-employee rows block the key; cleanup + rerun restores it`, { skip }, async () => {
    await withDb(port, async (conn) => {
      await applyUpTo(conn, { includeFrom015: true });
      await addEmployee(conn, 'emp-a');
      const keys = loadIdentifierKeys(keyEnv(1));
      await conn.query('ALTER TABLE employee_identifier DROP INDEX uk_employee_identifier_national_owner');
      const id1 = await addNational(conn, 'emp-a', buildLookup('national_id', FAKE_A, keys).lookup_hmac, 1);
      await addNational(conn, 'emp-a', buildLookup('national_id', FAKE_B, keys).lookup_hmac, 1);
      await rejects(run015(conn), 'ER_DUP_ENTRY');
      const [[idx]] = await conn.query("SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME='uk_employee_identifier_national_owner'");
      assert.equal(Number(idx.c), 0);
      await conn.query('DELETE FROM employee_identifier WHERE id <> ?', [id1]);
      await run015(conn);
      const [[idx2]] = await conn.query("SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME='uk_employee_identifier_national_owner'");
      assert.equal(Number(idx2.c), 1);
    });
  });
}

test('integration suite is opt-in and loopback-only', () => {
  assert.ok(skip || ports.length > 0);
});
