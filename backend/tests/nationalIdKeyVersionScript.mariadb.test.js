/**
 * `scripts/national-id-key-versions.mjs` against a REAL MariaDB (N-2).
 *
 * The pure unit test proves the classification rule; this one proves the SQL — the unit test would happily
 * pass while the query was syntactically invalid (`rows` is a reserved word in MariaDB, which is exactly how
 * the first version of the script failed). It also proves the exit code an operator relies on: 0 when every
 * stored version is still accepted, 2 when a version has been dropped and rows are orphaned.
 *
 * Skipped wherever no database is present, and it says so.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createNationalIdProtector } = require('../src/security/nationalIdContract');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const repoRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..', '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'national-id-key-versions.mjs');
const UID = '33333333-3333-3333-3333-333333333333';
const KEY = 'k'.repeat(40);

function runScript(keyVersionsEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NATIONAL_ID_HMAC_KEYS: keyVersionsEnv,
      MYSQL_HOST: process.env.DB_HOST || process.env.MYSQL_HOST,
      MYSQL_PORT: process.env.DB_PORT || process.env.MYSQL_PORT,
      MYSQL_USER: process.env.DB_USER || process.env.MYSQL_USER,
      MYSQL_PASSWORD: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD,
      MYSQL_DATABASE: process.env.DB_NAME || process.env.MYSQL_DATABASE,
    },
  });
}

test('N-2: the key-version audit runs on a real database and detects an orphaned version', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const digest = createNationalIdProtector({ keys: { 1: KEY } }).protect('9900000000002').lookup;

  t.after(async () => {
    await pool.query(
      "DELETE FROM employee_identifier WHERE employee_uid = ? AND id_type = 'national_id'",
      [UID],
    ).catch(() => {});
    await closePool();
  });

  // A digest written under version 1, and one under a version that the operator is about to "drop" (9).
  await pool.query("DELETE FROM employee_identifier WHERE employee_uid = ? AND id_type = 'national_id'", [UID]);
  await pool.query(
    `INSERT INTO employee_identifier (employee_uid, id_type, id_value, lookup_key_version, status, created_at, updated_at)
     VALUES (?, 'national_id', ?, 9, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [UID, digest],
  );

  const orphaned = runScript(`1:${KEY}`);
  assert.equal(orphaned.status, 2, `expected exit 2 for an orphaned version, got ${orphaned.status}: ${orphaned.stderr}`);
  assert.match(orphaned.stdout, /version 9: 1 row\(s\) ORPHANED/);
  assert.match(orphaned.stderr, /ORPHANED: 1 digest\(s\)/);

  // Point the same rows at the accepted version: the tool must now be clean, so exit 2 is not its default.
  await pool.query(
    "UPDATE employee_identifier SET lookup_key_version = 1 WHERE employee_uid = ? AND id_type = 'national_id'",
    [UID],
  );
  const clean = runScript(`1:${KEY}`);
  assert.equal(clean.status, 0, `expected exit 0 once the version is accepted, got ${clean.status}: ${clean.stderr}`);
  assert.match(clean.stdout, /version 1: 1 row\(s\) accepted/);
});
