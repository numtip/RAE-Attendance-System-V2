const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');
const { createFacescanNormalizationService } = require('../src/services/facescanNormalizationService');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { TIMEZONE_BANGKOK } = require('../src/domain/attendanceEvent');

function ctx() {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    ingestion: createFacescanIngestionService({ repositories }),
    normalize: createFacescanNormalizationService({ repositories }),
    identity: createEmployeeIdentityService({ repositories }),
  };
}

const hipRow = {
  USERID: 'FS-USER-001',
  CHECKTIME: '2026-09-01 08:05:00',
  CHECKTYPE: 'I',
  SensorID: 'S1',
};

test('resolved raw creates one attendance_event with lineage', async () => {
  const { ingestion, normalize, repositories } = ctx();
  const batch = await ingestion.startBatch({});
  const ing = await ingestion.ingestCheckinoutBatch(batch.batchUid, [hipRow]);
  const rawId = ing.results[0].id;

  const { created, results } = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  assert.equal(created, 1);
  assert.equal(results[0].outcome, 'created');

  const event = await repositories.attendanceEvents.findByStagingRawId(rawId);
  assert.equal(event.employeeUid, '22222222-2222-2222-2222-222222222222');
  assert.equal(event.importBatchUid, batch.batchUid);
  assert.equal(event.eventTime, '2026-09-01 08:05:00');
  assert.equal(event.timezoneLabel, TIMEZONE_BANGKOK);
  assert.equal(event.facescanId, 'FS-USER-001');
});

test('unmapped raw does not create attendance_event', async () => {
  const { ingestion, normalize, repositories } = ctx();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    ...hipRow,
    USERID: 'FS-NO-MAP-99',
    CHECKTIME: '2026-09-01 09:00:00',
  }]);
  const { created } = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  assert.equal(created, 0);
  const all = await repositories.attendanceEvents.listByEmployee('22222222-2222-2222-2222-222222222222');
  assert.equal(all.length, 0);
});

test('normalize is idempotent', async () => {
  const { ingestion, normalize } = ctx();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch.batchUid, [hipRow]);
  const first = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  const second = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.duplicate, 1);
});

test('re-resolve then normalize creates event safely', async () => {
  const { ingestion, normalize, identity } = ctx();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    USERID: 'FS-LATE-MAP',
    CHECKTIME: '2026-09-05 07:00:00',
    SensorID: 'A',
  }]);
  assert.equal((await normalize.normalizeResolved({ importBatchUid: batch.batchUid })).created, 0);

  await identity.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'facescan_id',
    idValue: 'FS-LATE-MAP',
  });
  await ingestion.reResolveUnmapped({ importBatchUid: batch.batchUid });

  const { created } = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  assert.equal(created, 1);
});

test('raw source fields unchanged after normalization', async () => {
  const { ingestion, normalize, repositories } = ctx();
  const batch = await ingestion.startBatch({});
  const ing = await ingestion.ingestCheckinoutBatch(batch.batchUid, [hipRow]);
  const before = await repositories.facescanIngestion.findRawById(ing.results[0].id);
  await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  const after = await repositories.facescanIngestion.findRawById(ing.results[0].id);
  assert.deepEqual(
    {
      facescanId: before.facescanId,
      checkTime: before.checkTime,
      sourceEventKey: before.sourceEventKey,
    },
    {
      facescanId: after.facescanId,
      checkTime: after.checkTime,
      sourceEventKey: after.sourceEventKey,
    },
  );
});

test('multiple scans same day produce multiple attendance_events', async () => {
  const { ingestion, normalize } = ctx();
  const batch = await ingestion.startBatch({});
  await ingestion.ingestCheckinoutBatch(batch.batchUid, [
    hipRow,
    { ...hipRow, CHECKTIME: '2026-09-01 17:30:00', CHECKTYPE: 'O' },
  ]);
  const { created } = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
  assert.equal(created, 2);
});
