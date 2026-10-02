const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');
const { createFacescanNormalizationService } = require('../src/services/facescanNormalizationService');
const { createAttendanceEventMariaDbRepository } = require('../src/repositories/mariadb/attendanceEventMariaDbRepository');
const { SOURCE_TYPE_FACESCAN_CHECKINOUT, TIMEZONE_BANGKOK } = require('../src/domain/attendanceEvent');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return isDatabaseConfigured();
  }
  return false;
}

function formatMariaDbDateTime(value) {
  if (value == null) return value;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

const TEST_PREFIX = 'FS-MDB-NORM';
const employeeUid = '22222222-2222-2222-2222-222222222222';

test('MariaDB FaceScan normalization (attendance_events Phase B)', { skip: !shouldRunMariaDbIntegration() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories(config.database);
  const ingestion = createFacescanIngestionService({ repositories });
  const normalize = createFacescanNormalizationService({ repositories });
  const attendanceEvents = createAttendanceEventMariaDbRepository(pool);

  t.after(async () => {
    await pool.query(
      `DELETE FROM attendance_events WHERE facescan_id LIKE ?`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM staging_facescan_raw WHERE facescan_id LIKE ?`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM employee_identifier WHERE id_value LIKE ?`,
      [`${TEST_PREFIX}%`],
    );
    await closePool();
  });

  const facescanId = `${TEST_PREFIX}-1`;
  await repositories.employeeIdentifiers.insert({
    employeeUid,
    idType: 'facescan_id',
    idValue: facescanId,
  });

  const batch = await ingestion.startBatch({ sourceReference: 'norm-mdb-test' });
  const checkTime = '2026-09-10 08:00:00';
  const ing = await ingestion.ingestCheckinoutBatch(batch.batchUid, [{
    USERID: facescanId,
    CHECKTIME: checkTime,
    SensorID: 'G1',
    CHECKTYPE: 'I',
  }]);
  const rawId = ing.results[0].id;
  const rawBefore = await repositories.facescanIngestion.findRawById(rawId);
  assert.equal(rawBefore.resolutionStatus, 'resolved');

  await t.test('resolved staging row -> one attendance_event', async () => {
    const first = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
    assert.equal(first.created, 1);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM attendance_events WHERE staging_facescan_raw_id = ?`,
      [rawId],
    );
    assert.equal(Number(countRows[0].c), 1);
    const event = await attendanceEvents.findByStagingRawId(rawId);
    assert.equal(event.employeeUid, employeeUid);
    assert.equal(event.importBatchUid, batch.batchUid);
    assert.equal(event.sourceSystem, rawBefore.sourceSystem);
    assert.equal(event.sourceEventKey, rawBefore.sourceEventKey);
    assert.equal(event.sourceType, SOURCE_TYPE_FACESCAN_CHECKINOUT);
  });

  await t.test('rerun normalize -> remains one row', async () => {
    const second = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
    assert.equal(second.created, 0);
    assert.equal(second.duplicate, 1);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM attendance_events WHERE staging_facescan_raw_id = ?`,
      [rawId],
    );
    assert.equal(Number(countRows[0].c), 1);
  });

  await t.test('UNIQUE staging_facescan_raw_id enforced', async () => {
    const existing = await attendanceEvents.findByStagingRawId(rawId);
    await assert.rejects(
      () => attendanceEvents.insert({
        employeeUid,
        stagingFacescanRawId: rawId,
        importBatchUid: batch.batchUid,
        sourceSystem: existing.sourceSystem,
        sourceEventKey: randomUUID().replace(/-/g, ''),
        sourceType: SOURCE_TYPE_FACESCAN_CHECKINOUT,
        facescanId: `${TEST_PREFIX}-dup-staging`,
        eventTime: checkTime,
        timezoneLabel: TIMEZONE_BANGKOK,
      }),
      (error) => error.code === 'DUPLICATE_STAGING_RAW' || error.code === 'DUPLICATE_EVENT',
    );
  });

  await t.test('UNIQUE source_system + source_event_key enforced', async () => {
    const existing = await attendanceEvents.findByStagingRawId(rawId);
    const otherBatch = await ingestion.startBatch({});
    const otherRaw = await repositories.facescanIngestion.insertRawEvent({
      sourceSystem: rawBefore.sourceSystem,
      sourceEventKey: randomUUID().replace(/-/g, ''),
      facescanId: `${TEST_PREFIX}-other-raw`,
      checkTime: '2026-09-10 09:00:00',
      checkType: 'I',
      verifyCode: null,
      sensorId: 'S2',
      workCode: null,
      employeeUid,
      resolutionStatus: 'resolved',
      importBatchUid: otherBatch.batchUid,
      rawPayload: {},
    });
    await assert.rejects(
      () => attendanceEvents.insert({
        employeeUid,
        stagingFacescanRawId: otherRaw.id,
        importBatchUid: otherBatch.batchUid,
        sourceSystem: existing.sourceSystem,
        sourceEventKey: existing.sourceEventKey,
        sourceType: SOURCE_TYPE_FACESCAN_CHECKINOUT,
        facescanId: otherRaw.facescanId,
        eventTime: otherRaw.checkTime,
        timezoneLabel: TIMEZONE_BANGKOK,
      }),
      (error) => error.code === 'DUPLICATE_SOURCE_EVENT' || error.code === 'DUPLICATE_EVENT',
    );
  });

  await t.test('unmapped raw -> no attendance_event', async () => {
    const unmappedBatch = await ingestion.startBatch({});
    const unmappedFacescan = `${TEST_PREFIX}-UNMAPPED`;
    await ingestion.ingestCheckinoutBatch(unmappedBatch.batchUid, [{
      USERID: unmappedFacescan,
      CHECKTIME: '2026-09-10 10:00:00',
      SensorID: 'U1',
    }]);
    const norm = await normalize.normalizeResolved({ importBatchUid: unmappedBatch.batchUid });
    assert.equal(norm.created, 0);
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM attendance_events WHERE facescan_id = ?`,
      [unmappedFacescan],
    );
    assert.equal(Number(rows[0].c), 0);
  });

  await t.test('reResolveUnmapped then normalize succeeds', async () => {
    const lateBatch = await ingestion.startBatch({});
    const lateFacescan = `${TEST_PREFIX}-LATE`;
    await ingestion.ingestCheckinoutBatch(lateBatch.batchUid, [{
      USERID: lateFacescan,
      CHECKTIME: '2026-09-11 07:00:00',
      SensorID: 'L1',
    }]);
    assert.equal((await normalize.normalizeResolved({ importBatchUid: lateBatch.batchUid })).created, 0);
    await repositories.employeeIdentifiers.insert({
      employeeUid: '11111111-1111-1111-1111-111111111111',
      idType: 'facescan_id',
      idValue: lateFacescan,
    });
    const re = await ingestion.reResolveUnmapped({ importBatchUid: lateBatch.batchUid });
    assert.equal(re.resolved, 1);
    const afterMap = await normalize.normalizeResolved({ importBatchUid: lateBatch.batchUid });
    assert.equal(afterMap.created, 1);
  });

  await t.test('employee FK enforced on attendance_events', async () => {
    const fkBatch = await ingestion.startBatch({});
    const fkRaw = await repositories.facescanIngestion.insertRawEvent({
      sourceSystem: 'hip_pm2014',
      sourceEventKey: randomUUID().replace(/-/g, ''),
      facescanId: `${TEST_PREFIX}-FK-EMP`,
      checkTime: '2026-09-12 08:00:00',
      checkType: 'I',
      verifyCode: null,
      sensorId: 'F1',
      workCode: null,
      employeeUid,
      resolutionStatus: 'resolved',
      importBatchUid: fkBatch.batchUid,
      rawPayload: {},
    });
    await assert.rejects(
      () => pool.query(
        `INSERT INTO attendance_events (
           event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
           source_system, source_event_key, source_type, facescan_id, event_time,
           timezone_label, normalized_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          randomUUID(),
          '99999999-9999-9999-9999-999999999999',
          fkRaw.id,
          fkBatch.batchUid,
          fkRaw.sourceSystem,
          fkRaw.sourceEventKey,
          SOURCE_TYPE_FACESCAN_CHECKINOUT,
          fkRaw.facescanId,
          fkRaw.checkTime,
          TIMEZONE_BANGKOK,
        ],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2' || error.errno === 1452,
    );
  });

  await t.test('staging raw FK enforced on attendance_events', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO attendance_events (
           event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
           source_system, source_event_key, source_type, facescan_id, event_time,
           timezone_label, normalized_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          randomUUID(),
          employeeUid,
          999999999,
          batch.batchUid,
          'hip_pm2014',
          randomUUID().replace(/-/g, ''),
          SOURCE_TYPE_FACESCAN_CHECKINOUT,
          `${TEST_PREFIX}-FK-RAW`,
          checkTime,
          TIMEZONE_BANGKOK,
        ],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2' || error.errno === 1452,
    );
  });

  await t.test('import batch FK and lineage fields', async () => {
    const event = await attendanceEvents.findByStagingRawId(rawId);
    assert.equal(event.importBatchUid, batch.batchUid);
    const [batchRows] = await pool.query(
      `SELECT batch_uid FROM facescan_import_batches WHERE batch_uid = ?`,
      [event.importBatchUid],
    );
    assert.equal(batchRows.length, 1);

    const validBatch = await ingestion.startBatch({});
    const lineageRaw = await repositories.facescanIngestion.insertRawEvent({
      sourceSystem: 'hip_pm2014',
      sourceEventKey: randomUUID().replace(/-/g, ''),
      facescanId: `${TEST_PREFIX}-FK-BATCH-RAW`,
      checkTime: '2026-09-12 09:00:00',
      checkType: 'I',
      verifyCode: null,
      sensorId: 'B1',
      workCode: null,
      employeeUid,
      resolutionStatus: 'resolved',
      importBatchUid: validBatch.batchUid,
      rawPayload: {},
    });
    await assert.rejects(
      () => pool.query(
        `INSERT INTO attendance_events (
           event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
           source_system, source_event_key, source_type, facescan_id, event_time,
           timezone_label, normalized_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          randomUUID(),
          employeeUid,
          lineageRaw.id,
          randomUUID(),
          lineageRaw.sourceSystem,
          lineageRaw.sourceEventKey,
          SOURCE_TYPE_FACESCAN_CHECKINOUT,
          lineageRaw.facescanId,
          lineageRaw.checkTime,
          TIMEZONE_BANGKOK,
        ],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2' || error.errno === 1452,
    );
  });

  await t.test('event_time equals raw check_time and timezone Asia/Bangkok', async () => {
    const event = await attendanceEvents.findByStagingRawId(rawId);
    const raw = await repositories.facescanIngestion.findRawById(rawId);
    assert.equal(formatMariaDbDateTime(event.eventTime), formatMariaDbDateTime(raw.checkTime));
    assert.equal(formatMariaDbDateTime(raw.checkTime), checkTime);
    assert.equal(event.timezoneLabel, TIMEZONE_BANGKOK);
  });

  await t.test('multiple scans same employee/day -> separate attendance_events', async () => {
    const multiBatch = await ingestion.startBatch({});
    const multiFacescan = `${TEST_PREFIX}-MULTI`;
    await repositories.employeeIdentifiers.insert({
      employeeUid,
      idType: 'facescan_id',
      idValue: multiFacescan,
    });
    await ingestion.ingestCheckinoutBatch(multiBatch.batchUid, [
      { USERID: multiFacescan, CHECKTIME: '2026-09-13 08:00:00', SensorID: 'M1', CHECKTYPE: 'I' },
      { USERID: multiFacescan, CHECKTIME: '2026-09-13 17:30:00', SensorID: 'M1', CHECKTYPE: 'O' },
    ]);
    const norm = await normalize.normalizeResolved({ importBatchUid: multiBatch.batchUid });
    assert.equal(norm.created, 2);
    const [rows] = await pool.query(
      `SELECT event_time FROM attendance_events WHERE facescan_id = ? ORDER BY event_time`,
      [multiFacescan],
    );
    assert.equal(rows.length, 2);
    assert.equal(formatMariaDbDateTime(rows[0].event_time), '2026-09-13 08:00:00');
    assert.equal(formatMariaDbDateTime(rows[1].event_time), '2026-09-13 17:30:00');
  });

  await t.test('raw staging unchanged after normalization', async () => {
    const rawAfter = await repositories.facescanIngestion.findRawById(rawId);
    assert.deepEqual(
      {
        facescanId: rawAfter.facescanId,
        checkTime: formatMariaDbDateTime(rawAfter.checkTime),
        sourceEventKey: rawAfter.sourceEventKey,
        resolutionStatus: rawAfter.resolutionStatus,
        employeeUid: rawAfter.employeeUid,
      },
      {
        facescanId: rawBefore.facescanId,
        checkTime: formatMariaDbDateTime(rawBefore.checkTime),
        sourceEventKey: rawBefore.sourceEventKey,
        resolutionStatus: rawBefore.resolutionStatus,
        employeeUid: rawBefore.employeeUid,
      },
    );
  });

  await t.test('normalizeStagingRawId duplicate is retry-safe', async () => {
    const single = await normalize.normalizeStagingRawId(rawId);
    assert.equal(single.outcome, 'duplicate');
    assert.ok(single.event);
  });
});
