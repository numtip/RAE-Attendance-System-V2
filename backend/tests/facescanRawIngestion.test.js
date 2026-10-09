const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanRawIngestionService } = require('../src/services/facescanRawIngestionService');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');

function createContext() {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    ingestion: createFacescanRawIngestionService({ repositories }),
    identity: createEmployeeIdentityService({ repositories }),
  };
}

const sampleRow = {
  facescanId: 'FS-USER-001',
  scanDatetime: '2026-09-01 08:05:00',
  scanType: 'in',
};

test('ingest resolves mapped facescan_id to employee_uid', async () => {
  const { ingestion } = createContext();
  const batch = await ingestion.startBatch({ sourceLabel: 'unit-test' });
  const { results, batch: finished } = await ingestion.ingestBatch(batch.id, [sampleRow]);
  assert.equal(results.length, 1);
  assert.equal(results[0].resolutionStatus, 'resolved');
  assert.equal(results[0].employeeUid, '22222222-2222-2222-2222-222222222222');
  assert.equal(finished.resolvedCount, 1);
  assert.equal(finished.unmappedCount, 0);
});

test('ingest marks unknown facescan_id as unmapped', async () => {
  const { ingestion } = createContext();
  const batch = await ingestion.startBatch({});
  const { results } = await ingestion.ingestBatch(batch.id, [{
    facescanId: 'FS-UNKNOWN-999',
    scanDatetime: '2026-09-01 09:00:00',
    scanType: 'out',
  }]);
  assert.equal(results[0].resolutionStatus, 'unmapped');
  assert.equal(results[0].employeeUid, undefined);
});

test('duplicate scan is idempotent', async () => {
  const { ingestion } = createContext();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestBatch(batch.id, [sampleRow]);
  const batch2 = await ingestion.startBatch({});
  const { results, batch: stats } = await ingestion.ingestBatch(batch2.id, [sampleRow]);
  assert.equal(results[0].resolutionStatus, 'duplicate');
  assert.equal(stats.duplicateCount, 1);
  assert.equal(stats.insertedCount, 0);
});

test('re-resolve links employee_uid after facescan_id mapping added', async () => {
  const { ingestion, identity } = createContext();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestBatch(batch.id, [{
    facescanId: 'FS-NEW-MAP-001',
    scanDatetime: '2026-09-02 07:30:00',
    scanType: 'in',
  }]);
  await identity.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'facescan_id',
    idValue: 'FS-NEW-MAP-001',
  });
  const { resolved, stillUnmapped, updates } = await ingestion.reResolveUnmapped({ batchId: batch.id });
  assert.equal(resolved, 1);
  assert.equal(stillUnmapped, 0);
  assert.equal(updates[0].employeeUid, '11111111-1111-1111-1111-111111111111');
});

test('identity resolve facescan_id matches ingestion mapping', async () => {
  const { identity } = createContext();
  const uid = await identity.resolveUid('facescan_id', 'FS-USER-001');
  assert.equal(uid, '22222222-2222-2222-2222-222222222222');
});
