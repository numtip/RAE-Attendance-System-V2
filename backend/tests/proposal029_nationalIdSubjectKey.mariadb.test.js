/**
 * Proposal 029 (N-6) — the cross-version uniqueness guard, exercised on a REAL MariaDB.
 *
 * Everything happens on a probe table cloned with `CREATE TABLE ... LIKE employee_identifier`, so the real
 * table is never altered and this test is safe to run in the shared CI database. The probe is dropped in
 * cleanup, and the test is skipped wherever no database is present.
 *
 * The five assertions are the ones the proposal document claims; if this file and
 * `docs/proposals/029_national_id_subject_key.md` ever disagree, the document is wrong.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const PROBE = 'employee_identifier_probe029';
const UP = [
  `ALTER TABLE ${PROBE} ADD COLUMN national_id_subject_key CHAR(64) NULL DEFAULT NULL AFTER lookup_key_version`,
  `CREATE UNIQUE INDEX uk_${PROBE}_national_subject ON ${PROBE} (national_id_subject_key)`,
];
const DOWN = [
  `DROP INDEX uk_${PROBE}_national_subject ON ${PROBE}`,
  `ALTER TABLE ${PROBE} DROP COLUMN national_id_subject_key`,
];

const UID_B = '11111111-1111-1111-1111-111111111111'; // seeded fixture employees
const UID_C = '22222222-2222-2222-2222-222222222222';
const UID_A = '33333333-3333-3333-3333-333333333333';
const DIGEST_V1 = 'a'.repeat(64); // stand-ins for the same person under two key versions
const DIGEST_V2 = 'b'.repeat(64);
const SUBJECT = 'c'.repeat(64); // the rotation-invariant subject key: identical for that person

async function insertRow(pool, uid, idValue, subjectKey) {
  await pool.query(
    `INSERT INTO ${PROBE} (employee_uid, id_type, id_value, lookup_key_version, national_id_subject_key, status, created_at, updated_at)
     VALUES (?, 'national_id', ?, 1, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [uid, idValue, subjectKey],
  );
}

test('proposal 029: the cross-version guard behaves as documented', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);

  t.after(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${PROBE}`).catch(() => {});
    await closePool();
  });

  // A clone carries the real columns and keys, so this exercises the actual schema shape.
  await pool.query(`DROP TABLE IF EXISTS ${PROBE}`);
  await pool.query(`CREATE TABLE ${PROBE} LIKE employee_identifier`);

  // 1: the DDL is accepted by the engine the repository pins.
  const [[{ version }]] = await pool.query('SELECT VERSION() AS version');
  assert.match(String(version), /^(10\.11|11\.4)/, `unexpected engine ${version}`);
  for (const stmt of UP) await pool.query(stmt);

  // 2: the same person under two key versions — different digests, one subject key — is refused.
  await insertRow(pool, UID_B, DIGEST_V1, SUBJECT);
  await assert.rejects(
    () => insertRow(pool, UID_C, DIGEST_V2, SUBJECT),
    (error) => error.code === 'ER_DUP_ENTRY',
    'a second row for the same person must be refused even though the digest differs by key version',
  );

  // 3: a genuinely different person is still accepted, so the index is not blocking everything.
  await insertRow(pool, UID_C, DIGEST_V2, randomUUID().replace(/-/g, '').padEnd(64, 'd'));

  // 4: NULL subject keys are allowed — the partial guard the proposal states in §3.3, pinned not assumed.
  // The 015 owner key allows one national_id row per employee, so the first row is removed to free UID_B;
  // two employees are then written without a subject key, which is exactly the not-yet-backfilled state.
  await pool.query(`DELETE FROM ${PROBE} WHERE employee_uid = ?`, [UID_B]);
  await insertRow(pool, UID_B, 'e'.repeat(64), null);
  await insertRow(pool, UID_A, 'f'.repeat(64), null);
  const [nulls] = await pool.query(
    `SELECT COUNT(*) AS n FROM ${PROBE} WHERE national_id_subject_key IS NULL`,
  );
  assert.equal(Number(nulls[0].n), 2);

  // 5: DOWN is real and UP re-applies — a rollback that leaves the schema different is not a rollback.
  for (const stmt of DOWN) await pool.query(stmt);
  const [afterDown] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'national_id_subject_key'`,
    [PROBE],
  );
  assert.equal(Number(afterDown[0].n), 0);
  const [rowsSurvive] = await pool.query(`SELECT COUNT(*) AS n FROM ${PROBE}`);
  // row1 was deleted for the NULL test; the two NULL rows and the different-person row survive.
  assert.equal(Number(rowsSurvive[0].n), 3, 'the rollback must not delete identifier rows');
  for (const stmt of UP) await pool.query(stmt);
});
