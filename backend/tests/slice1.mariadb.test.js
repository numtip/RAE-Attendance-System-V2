/**
 * Slice 1 MariaDB integration (opt-in).
 *
 * Requires migrations 001-021 to be applied (CI's `backend-mariadb` job runs `db:migrate:seed` first).
 * Covers what the fixture repositories cannot: the real DDL, the transactional conflict checks and the
 * DATE columns of migration 020/021.
 *
 * Local run:  RUN_MARIADB_TESTS=1 + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD with a THROW-AWAY
 * database. Never point this at production.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return isDatabaseConfigured();
  }
  return false;
}

const SKIP = !shouldRunMariaDbIntegration();

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const RAW_FS = `FS-SLICE1-RAW-${process.pid}`;

test('migration 020/021 columns exist and employee_assignment enforces its window', { skip: SKIP }, async (t) => {
  const config = require('../src/config');
  const { getPool, closePool } = require('../src/db/pool');
  const { createEmployeeAssignmentMariaDbRepository } = require('../src/repositories/mariadb/employeeAssignmentMariaDbRepository');
  const pool = getPool(config.database);
  const repo = createEmployeeAssignmentMariaDbRepository(pool);

  t.after(async () => {
    await pool.query('DELETE FROM employee_assignment WHERE employee_code LIKE ?', ['SLICE1-%']);
    await closePool();
  });

  // The DDL is what migration 020/021 adds; if either file did not apply, these queries throw.
  const [identifierCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
       AND COLUMN_NAME IN ('effective_from', 'effective_to')`,
  );
  assert.equal(identifierCols.length, 2, 'migration 020 adds the validity window to employee_identifier');

  const [batchCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches'
       AND COLUMN_NAME IN ('file_name', 'input_sha256', 'parser_version', 'column_map_json')`,
  );
  assert.equal(batchCols.length, 4, 'migration 021 adds the file-provenance columns');

  const base = {
    employeeUid: USER_UID,
    employeeCode: 'SLICE1-A',
    department: 'QA',
    employeeType: 'university',
    sourceSystem: 'slice1-test',
  };

  const first = await repo.insert({ ...base, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
  assert.equal(first.effectiveFrom, '2026-01-01');
  assert.equal(first.effectiveTo, '2026-06-30');

  // Adjacent window is allowed.
  const second = await repo.insert({
    ...base,
    employeeCode: 'SLICE1-B',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
  });
  assert.equal(second.effectiveTo, null);

  // Overlap for the same employee is rejected.
  await assert.rejects(
    () => repo.insert({ ...base, employeeCode: 'SLICE1-C', effectiveFrom: '2026-06-01', effectiveTo: '2026-08-01' }),
    (error) => error.status === 409 && error.code === 'ASSIGNMENT_WINDOW_OVERLAP',
  );

  // The same employee_code held by another employee over an overlapping window is rejected.
  await assert.rejects(
    () => repo.insert({
      ...base,
      employeeUid: ADMIN_UID,
      employeeCode: 'SLICE1-B',
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
    }),
    (error) => error.status === 409 && error.code === 'ASSIGNMENT_CODE_CONFLICT',
  );

  // Effective-dated reads.
  assert.equal((await repo.findEffectiveOn(USER_UID, '2026-03-01')).employeeCode, 'SLICE1-A');
  assert.equal((await repo.findEffectiveOn(USER_UID, '2026-09-01')).employeeCode, 'SLICE1-B');
  assert.equal(await repo.findEffectiveOn(USER_UID, '2025-12-31'), null);
});

test('effective-dated identifier lookup and validity audit against MariaDB', { skip: SKIP }, async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
  const config = require('../src/config');
  const { getPool, closePool } = require('../src/db/pool');
  const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
  const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
  const repositories = createMariaDbRepositories(config.database);
  const identity = createEmployeeIdentityService({ repositories });

  const cleanup = async () => {
    await getPool(config.database).query(
      'DELETE FROM employee_identifier WHERE id_value = ?', [RAW_FS],
    );
    await closePool();
  };
  t.after(cleanup);

  const link = await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: RAW_FS,
    sourceSystem: 'slice1-test',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    actor: 'operator:slice1-test',
    reason: 'slice1:test',
  });
  assert.equal(link.effectiveFrom, '2026-01-01');
  assert.equal(link.effectiveTo, '2026-06-30');

  assert.equal(await identity.resolveUid('facescan_id', RAW_FS, { onDate: '2026-03-01' }), USER_UID);
  await assert.rejects(
    () => identity.resolveUid('facescan_id', RAW_FS, { onDate: '2026-09-01' }),
    (error) => error.code === 'EMPLOYEE_NOT_FOUND',
  );

  const explanation = await identity.explainResolution('facescan_id', RAW_FS, { onDate: '2026-09-01' });
  assert.equal(explanation.outcome, 'not_effective');
  assert.equal(explanation.reason, 'expired');
  assert.equal(JSON.stringify(explanation).includes(RAW_FS), false);

  const closed = await identity.unlinkIdentifier({
    id: link.id,
    employeeUid: USER_UID,
    effectiveTo: '2026-06-30',
    actor: 'operator:slice1-test',
    reason: 'slice1:close',
  });
  assert.equal(closed.status, 'inactive');

  const events = await identity.listValidityEvents({ employeeUid: USER_UID, limit: 5 });
  assert.ok(events.some((event) => event.action === 'effective_change'));
  assert.equal(JSON.stringify(events).includes(RAW_FS), false, 'the audit trail holds no identifier value');
});
