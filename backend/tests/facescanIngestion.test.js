const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { buildSourceEventKey, normalizeCheckinoutRow } = require('../src/domain/facescanIngestion');

function ctx() {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    ingestion: createFacescanIngestionService({ repositories }),
    identity: createEmployeeIdentityService({ repositories }),
  };
}

const mappedEvent = {
  USERID: 'FS-USER-001',
  CHECKTIME: '2026-09-01 08:05:00',
  CHECKTYPE: 'I',
  VERIFYCODE: '1',
  SensorID: 'S1',
  WorkCode: '0',
};

test('valid FaceScan CHECKINOUT import resolves employee_uid', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const { results, batch: done } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [mappedEvent]);
  assert.equal(results[0].outcome, 'inserted');
  assert.equal(results[0].resolutionStatus, 'resolved');
  assert.equal(results[0].employeeUid, '22222222-2222-2222-2222-222222222222');
  assert.equal(done.rowsInserted, 1);
  assert.equal(done.rowsUnmapped, 0);
});

test('unknown FaceScan ID stored as unmapped', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const { results } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    ...mappedEvent,
    USERID: 'FS-UNKNOWN-404',
  }]);
  assert.equal(results[0].resolutionStatus, 'unmapped');
  assert.equal(results[0].employeeUid, undefined);
});

test('duplicate event ignored on second import', async () => {
  const { ingestion } = ctx();
  const batch1 = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch1.batchUid, [mappedEvent]);
  const batch2 = await ingestion.startBatch({});
  const { results, batch: done } = await ingestion.ingestCheckinoutBatch(batch2.batchUid, [mappedEvent]);
  assert.equal(results[0].outcome, 'duplicate');
  assert.equal(done.rowsDuplicate, 1);
  assert.equal(done.rowsInserted, 0);
});

test('repeated batch import of same rows stays idempotent', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch.batchUid, [mappedEvent]);
  const batch2 = await ingestion.startBatch({});
  const second = await ingestion.ingestCheckinoutBatch(batch2.batchUid, [mappedEvent]);
  assert.equal(second.batch.rowsDuplicate, 1);
});

test('multiple scans same user and day are retained', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const morning = { ...mappedEvent, CHECKTIME: '2026-09-01 08:05:00' };
  const evening = { ...mappedEvent, CHECKTIME: '2026-09-01 17:30:00', CHECKTYPE: 'O' };
  const { results } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [morning, evening]);
  assert.equal(results.filter((r) => r.outcome === 'inserted').length, 2);
});

test('same timestamp different sensors create distinct events', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const a = { ...mappedEvent, SensorID: 'GATE-A' };
  const b = { ...mappedEvent, SensorID: 'GATE-B' };
  const { results } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [a, b]);
  assert.equal(results.filter((r) => r.outcome === 'inserted').length, 2);
  const normA = normalizeCheckinoutRow(a);
  const normB = normalizeCheckinoutRow(b);
  assert.notEqual(buildSourceEventKey(normA), buildSourceEventKey(normB));
});

test('malformed USERID increments failed count', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const { results, batch: done } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    USERID: '',
    CHECKTIME: '2026-09-01 08:05:00',
  }]);
  assert.equal(results[0].outcome, 'failed');
  assert.equal(done.rowsFailed, 1);
});

test('malformed CHECKTIME increments failed count', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const { results, batch: done } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    USERID: 'FS-USER-001',
    CHECKTIME: 'not-a-date',
  }]);
  assert.equal(results[0].outcome, 'failed');
  assert.equal(done.rowsFailed, 1);
});

test('optional CHECKTYPE may be omitted', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const row = { USERID: 'FS-USER-001', CHECKTIME: '2026-09-02 08:00:00', SensorID: 'S9' };
  const { results } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [row]);
  assert.equal(results[0].outcome, 'inserted');
});

test('mapping added later re-resolves unmapped event without changing source facts', async () => {
  const { ingestion, identity, repositories } = ctx();
  const batch = await ingestion.startBatch({});
  const row = {
    USERID: 'FS-REMAP-77',
    CHECKTIME: '2026-09-03 07:15:00',
    SensorID: 'LAB-1',
    CHECKTYPE: 'I',
  };
  const first = await ingestion.ingestCheckinoutBatch(batch.batchUid, [row]);
  assert.equal(first.results[0].resolutionStatus, 'unmapped');
  const eventId = first.results[0].id;
  const before = await repositories.facescanIngestion.findBySourceEventKey(first.results[0].sourceEventKey);

  await identity.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'facescan_id',
    idValue: 'FS-REMAP-77',
  });

  const { resolved, updates } = await ingestion.reResolveUnmapped({ importBatchUid: batch.batchUid });
  assert.equal(resolved, 1);
  assert.equal(updates[0].id, eventId);
  assert.equal(updates[0].facescanIdUnchanged, true);
  assert.equal(updates[0].checkTimeUnchanged, true);
  assert.equal(updates[0].sourceEventKeyUnchanged, true);

  const after = await repositories.facescanIngestion.findBySourceEventKey(first.results[0].sourceEventKey);
  assert.equal(after.facescanId, before.facescanId);
  assert.equal(after.checkTime, before.checkTime);
  assert.equal(after.sourceEventKey, before.sourceEventKey);
  assert.equal(after.resolutionStatus, 'resolved');
});

test('batch counters reflect read insert duplicate unmapped failed', async () => {
  const { ingestion } = ctx();
  const batch = await ingestion.startBatch({});
  const { batch: done } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [
    mappedEvent,
    mappedEvent,
    { USERID: 'FS-NO-MAP', CHECKTIME: '2026-09-04 08:00:00', SensorID: 'X1' },
    { USERID: '', CHECKTIME: '2026-09-04 08:01:00' },
  ]);
  assert.equal(done.rowsRead, 4);
  assert.equal(done.rowsInserted, 2);
  assert.equal(done.rowsDuplicate, 1);
  assert.equal(done.rowsUnmapped, 1);
  assert.equal(done.rowsFailed, 1);
});

test('identity resolve facescan_id matches ingestion path', async () => {
  const { identity } = ctx();
  const uid = await identity.resolveUid('facescan_id', 'FS-USER-001');
  assert.equal(uid, '22222222-2222-2222-2222-222222222222');
});
