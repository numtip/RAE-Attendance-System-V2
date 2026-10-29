/**
 * The facescan staging repository against the REAL schema (regression guard).
 *
 * The repository used to query the pre-`015_facescan_hip_ingestion` column names, so on any migrated database
 * every statement failed with `ER_BAD_FIELD_ERROR` (`Unknown column 'batch_id'`). Nothing caught it because the
 * only ingestion test used the fixture repository — a fixture twin that cannot drift-proof SQL.
 *
 * This test drives the MariaDB repository through one complete ingest lifecycle and would fail on the first
 * statement if the SQL ever drifts from `staging_facescan_raw` / `facescan_import_batches` again. Skipped
 * wherever no database is present.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createFacescanRawMariaDbRepository } = require('../src/repositories/mariadb/facescanRawMariaDbRepository');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const EMPLOYEE = '33333333-3333-3333-3333-333333333333'; // seeded fixture employee (FK target)
const BATCH = randomUUID();
const EVENT_KEY = randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

test('facescan staging repository matches the migrated schema end to end', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repo = createFacescanRawMariaDbRepository(pool);

  t.after(async () => {
    await pool.query('DELETE FROM staging_facescan_raw WHERE import_batch_uid = ?', [BATCH]).catch(() => {});
    await pool.query('DELETE FROM facescan_import_batches WHERE batch_uid = ?', [BATCH]).catch(() => {});
    await closePool();
  });

  // 1: batch creation — would throw ER_BAD_FIELD_ERROR on the old column names.
  const created = await repo.createBatch({ id: BATCH, sourceSystem: 'hip_pm2014', sourceLabel: 'unit-test' });
  assert.equal(created.id, BATCH);
  assert.equal(created.status, 'open');
  assert.equal(created.sourceLabel, 'unit-test');
  assert.equal(created.resolvedCount, 0);

  // 2: an unmapped staging row, keyed by the idempotency key the schema calls source_event_key.
  const inserted = await repo.insertRawRow({
    batchId: BATCH,
    facescanId: 'FS-0001',
    scanDatetime: '2026-10-29 08:31:00',
    scanType: 'IN',
    payloadJson: { ScanId: 'FS-0001', VerifyCode: 'x' },
    idempotencyKey: EVENT_KEY,
    resolutionStatus: 'unmapped',
  });
  assert.ok(inserted.id);
  assert.equal(inserted.batchId, BATCH);
  assert.equal(inserted.idempotencyKey, EVENT_KEY);
  assert.equal(inserted.resolutionStatus, 'unmapped');
  // The schema has no updated_at on staging rows; the contract says null rather than a fabricated value.
  assert.equal(inserted.updatedAt, null);

  // 3: lookups both ways.
  const byKey = await repo.findByIdempotencyKey(EVENT_KEY);
  assert.equal(byKey.id, inserted.id);
  const unmapped = await repo.listUnmapped({ batchId: BATCH });
  assert.deepEqual(unmapped.map((row) => row.id), [inserted.id]);

  // 4: counters are written, resolved count is DERIVED from the staging rows.
  const counted = await repo.updateBatchCounters(BATCH, {
    rowCount: 1, insertedCount: 1, duplicateCount: 0, unmappedCount: 1, resolvedCount: 0,
  });
  assert.equal(counted.rowCount, 1);
  assert.equal(counted.unmappedCount, 1);
  assert.equal(counted.resolvedCount, 0);

  const resolved = await repo.resolveRow(inserted.id, { employeeUid: EMPLOYEE, resolutionStatus: 'resolved' });
  assert.equal(resolved.resolutionStatus, 'resolved');
  assert.equal(resolved.employeeUid, EMPLOYEE);
  assert.ok(resolved.resolvedAt);
  assert.equal((await repo.listUnmapped({ batchId: BATCH })).length, 0);

  const afterResolve = await repo.findBatch(BATCH);
  assert.equal(afterResolve.resolvedCount, 1, 'resolvedCount must be derived from the staging rows');

  // 5: commit uses a status that exists in the enum and stamps the completion time.
  const committed = await repo.commitBatch(BATCH);
  assert.equal(committed.status, 'completed');
  assert.ok(committed.finishedAt);
});
