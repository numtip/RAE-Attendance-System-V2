const assert = require('node:assert/strict');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createEmployeeIdentifierMariaDbRepository } = require('../src/repositories/mariadb/employeeIdentifierMariaDbRepository');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return isDatabaseConfigured();
  }
  return false;
}

test('MariaDB employee_identifier FK and unique constraints', { skip: !shouldRunMariaDbIntegration() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repo = createEmployeeIdentifierMariaDbRepository(pool);

  t.after(async () => {
    await pool.query(
      `DELETE FROM employee_identifier WHERE id_value IN ('P-MDB-TEST', 'FS-MDB-TEST')`,
    );
    await closePool();
  });

  await assert.rejects(
    () => repo.insert({
      employeeUid: '99999999-9999-9999-9999-999999999999',
      idType: 'personnel_id',
      idValue: 'P-MDB-TEST',
    }),
    (error) => error.code === 'UNKNOWN_EMPLOYEE',
  );

  const linked = await repo.insert({
    employeeUid: '22222222-2222-2222-2222-222222222222',
    idType: 'personnel_id',
    idValue: 'P-MDB-TEST',
  });
  assert.ok(linked.id);

  await assert.rejects(
    () => repo.insert({
      employeeUid: '11111111-1111-1111-1111-111111111111',
      idType: 'personnel_id',
      idValue: 'P-MDB-TEST',
    }),
    (error) => error.code === 'DUPLICATE_IDENTIFIER',
  );
});
