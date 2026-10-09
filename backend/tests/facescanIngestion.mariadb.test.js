const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { closePool } = require('../src/db/pool');
const { getPool } = require('../src/db/pool');
const { createFacescanIngestionMariaDbRepository } = require('../src/repositories/mariadb/facescanIngestionMariaDbRepository');
const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');
const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return isDatabaseConfigured();
  }
  return false;
}

test('MariaDB FaceScan HIP ingestion constraints and flow', { skip: !shouldRunMariaDbIntegration() }, async (t) => {
  const config = require('../src/config');
  const repositories = createMariaDbRepositories(config.database);
  const rawRepo = createFacescanIngestionMariaDbRepository(getPool(config.database));
  const ingestion = createFacescanIngestionService({ repositories });
  const userUid = '22222222-2222-2222-2222-222222222222';

  t.after(async () => {
    await closePool();
  });

  const batch = await ingestion.startBatch({ sourceReference: 'mariadb-test' });
  const event = {
    USERID: 'FS-MDB-HIP-1',
    CHECKTIME: '2026-09-10 08:00:00',
    SensorID: 'G1',
    CHECKTYPE: 'I',
  };

  await repositories.employeeIdentifiers.insert({
    employeeUid: userUid,
    idType: 'facescan_id',
    idValue: 'FS-MDB-HIP-1',
  });

  const first = await ingestion.ingestCheckinoutBatch(batch.batchUid, [event]);
  assert.equal(first.results[0].outcome, 'inserted');
  assert.equal(first.results[0].employeeUid, userUid);
  assert.equal(first.batch.rowsInserted, 1);

  const second = await ingestion.ingestCheckinoutBatch(
    (await ingestion.startBatch()).batchUid,
    [event],
  );
  assert.equal(second.results[0].outcome, 'duplicate');
  assert.equal(second.batch.rowsDuplicate, 1);

  const unmappedBatch = await ingestion.startBatch({});
  const unmapped = await ingestion.ingestCheckinoutBatch(unmappedBatch.batchUid, [{
    ...event,
    USERID: 'FS-MDB-NO-MAP',
    CHECKTIME: '2026-09-10 09:00:00',
  }]);
  assert.equal(unmapped.results[0].resolutionStatus, 'unmapped');

  await repositories.employeeIdentifiers.insert({
    employeeUid: userUid,
    idType: 'facescan_id',
    idValue: 'FS-MDB-NO-MAP',
  });
  const re = await ingestion.reResolveUnmapped({ importBatchUid: unmappedBatch.batchUid });
  assert.equal(re.resolved, 1);

  await assert.rejects(
    () => rawRepo.insertRawEvent({
      sourceSystem: 'hip_pm2014',
      sourceEventKey: randomUUID().replace(/-/g, ''),
      facescanId: 'FS-ORPHAN',
      checkTime: '2026-09-10 10:00:00',
      checkType: 'I',
      verifyCode: null,
      sensorId: 'X',
      workCode: null,
      employeeUid: '99999999-9999-9999-9999-999999999999',
      resolutionStatus: 'unmapped',
      importBatchUid: batch.batchUid,
      rawPayload: {},
    }),
    (error) => error.code === 'ER_NO_REFERENCED_ROW_2' || error.errno === 1452,
  );
});
