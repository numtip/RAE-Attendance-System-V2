/**
 * The national-ID digest contract against a REAL MariaDB — the part fixtures cannot prove.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * PR #60's own 46 new tests are fixture/fake-pool only: the MariaDB repository was exercised through a fake
 * pool, so nothing proved that migration 015's CHECK, the `lookup_key_version` column and a real
 * `SELECT ... WHERE id_value = ?` behave as the digest design assumes. The security review called that out,
 * and this file closes it with three assertions on the real server:
 *
 *   1. a national-ID row is STORED as a 64-hex digest with a key version, never the raw 13 digits;
 *   2. the schema REFUSES a raw value — the protection is enforced by the database, not only by the service;
 *   3. a stored digest is findable by the digest the protector produces from the same raw ID, which is what
 *      a lookup actually does.
 *
 * Synthetic values only: `9900000000002` is checksum-valid by construction and belongs to nobody.
 * Skipped wherever no database is present, and it says so instead of reporting a false pass.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createEmployeeIdentifierMariaDbRepository } = require('../src/repositories/mariadb/employeeIdentifierMariaDbRepository');
const { createNationalIdProtector } = require('../src/security/nationalIdContract');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

// A seeded fixture employee (database/seeds/dev-fixtures.sql): the FK needs a real row, and this one is not
// used by the other identifier suite, so cleanup cannot race it.
const UID = '33333333-3333-3333-3333-333333333333';
const RAW = '9900000000002';
const TEST_KEY = 'k'.repeat(40);

test('national-ID digests on a real MariaDB', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repo = createEmployeeIdentifierMariaDbRepository(pool);
  const protector = createNationalIdProtector({ keys: { 1: TEST_KEY } });
  const { lookup, keyVersion } = protector.protect(RAW);

  t.after(async () => {
    await pool.query(
      "DELETE FROM employee_identifier WHERE employee_uid = ? AND id_type = 'national_id'",
      [UID],
    ).catch(() => {});
    await closePool();
  });

  // 1 + 3: stored as a digest with its version, and findable by the digest of the same raw ID.
  const inserted = await repo.insert({
    employeeUid: UID,
    idType: 'national_id',
    idValue: lookup,
    lookupKeyVersion: keyVersion,
  });
  assert.ok(inserted.id);
  assert.equal(inserted.idValue, lookup);
  assert.equal(String(inserted.idValue).length, 64);
  assert.match(String(inserted.idValue), /^[0-9a-f]{64}$/);
  assert.equal(Number(inserted.lookupKeyVersion), 1);
  assert.equal(String(inserted.idValue).includes(RAW), false);

  const found = await repo.findActiveByTypeAndValue('national_id', lookup);
  assert.equal(found?.id, inserted.id);
  assert.equal(found?.employeeUid, UID);

  // 2: the SCHEMA refuses the raw value. The repository refuses it first (NATIONAL_ID_MUST_BE_PROTECTED), so
  // this assertion bypasses the repository on purpose: the protection must hold at the database boundary too.
  await assert.rejects(
    () => repo.insert({ employeeUid: UID, idType: 'national_id', idValue: RAW }),
    (error) => error.code === 'NATIONAL_ID_MUST_BE_PROTECTED',
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO employee_identifier (employee_uid, id_type, id_value, lookup_key_version, status, created_at, updated_at)
       VALUES (?, 'national_id', ?, 1, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [UID, RAW],
    ),
    // MariaDB reports the named CHECK either as ER_CHECK_CONSTRAINT_VIOLATED or ER_CONSTRAINT_FAILED
    // depending on version; the constraint NAME is the stable fact, and the row-count assertion below is the
    // behavioural one.
    (error) => /chk_employee_identifier_national_lookup/.test(String(error.message))
      || /ER_(CHECK_)?CONSTRAINT_(VIOLATED|FAILED)/.test(String(error.code)),
  );
  const [plaintextRows] = await pool.query(
    "SELECT COUNT(*) AS n FROM employee_identifier WHERE id_value = ?",
    [RAW],
  );
  assert.equal(Number(plaintextRows[0].n), 0);
});
