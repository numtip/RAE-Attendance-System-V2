// HIP FaceScan file ingestion (csvExport seam). Synthetic fixtures only — no real export, no names.
// TZ is pinned to UTC like the deploy containers, so Bangkok wall clock cannot pass by accident.
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanRawIngestionService } = require('../src/services/facescanRawIngestionService');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../src/services/facescanAttendanceIngestionService');
const { parseFacescanCsvExport, parseScanDatetime } = require('../src/imports/facescanCsvExport');

const adminUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222'; // owns facescan_id FS-USER-001 in the fixtures
const exec = { role: 'EXECUTIVE', employeeUid: adminUid };

const FILE = [
  'facescan_id,scan_datetime,scan_type,employee_name',
  'FS-USER-001,2026-11-16 08:41:00,in,Synthetic Person',
  'FS-USER-001,16/11/2569 12:02,,Synthetic Person',
  'FS-USER-001,2026-11-16T16:35:00,out,Synthetic Person',
  'FS-UNKNOWN-777,2026-11-16 08:00:00,in,Nobody',
].join('\r\n');

function build() {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(uid) {
      return uid === adminUid ? [{ employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' }] : [];
    },
    async uidsInOrgUnits() {
      return [];
    },
  };
  const ingestion = createFacescanRawIngestionService({ repositories });
  return { repositories, ingestion };
}

test('parser: canonical columns by name; other columns never leave the module', () => {
  const { rows, contentSha256 } = parseFacescanCsvExport(Buffer.from(`\uFEFF${FILE}`, 'utf8'));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    facescanId: 'FS-USER-001', scanDatetime: '2026-11-16 08:41:00', scanType: 'in', payload: { sourceLine: 2 },
  });
  assert.equal(rows[1].scanDatetime, '2026-11-16 12:02:00', 'BE 2569 is CE 2026');
  assert.equal(rows[1].scanType, 'unknown');
  assert.equal(JSON.stringify(rows).includes('Synthetic Person'), false, 'names must not be carried');
  assert.match(contentSha256, /^[0-9a-f]{64}$/);
});

test('parser: Bangkok wall clock only — zones, impossible dates and ambiguous eras are refused', () => {
  assert.equal(parseScanDatetime('2026-11-16 8:05'), '2026-11-16 08:05:00');
  for (const bad of [
    '2026-11-16T01:30:00Z', '2026-11-16 08:30:00+07:00', '2026-02-31 08:00', '31/04/2569 08:00',
    '16/11/2026 08:00', '2569-11-16 08:00', '2026-11-16', '2026-11-16 24:00', 'yesterday',
  ]) {
    assert.equal(parseScanDatetime(bad), null, bad);
  }
});

test('parser: one bad line refuses the whole file and names the line', () => {
  const text = `${FILE}\r\nFS-USER-001,2026-11-16T09:00:00Z,in,x\r\n,2026-11-16 09:00,in,x`;
  assert.throws(() => parseFacescanCsvExport(text), (error) => {
    assert.equal(error.code, 'FACESCAN_FILE_INVALID');
    assert.deepEqual(error.issues.map((issue) => issue.line), [6, 7]);
    return true;
  });
});

test('parser: an empty file, a header-only file and a missing column fail loudly', () => {
  assert.throws(() => parseFacescanCsvExport(''), /empty/);
  assert.throws(() => parseFacescanCsvExport('facescan_id,scan_datetime\r\n'), /no scan rows/);
  assert.throws(() => parseFacescanCsvExport('facescan_id,time\r\nA,2026-11-16 08:00'), /scan_datetime/);
  assert.throws(() => parseFacescanCsvExport(Buffer.from([0x66, 0xff, 0xfe, 0x0a])), /not UTF-8/);
});

test('ingestFile: a refused file creates no batch and no rows', async () => {
  const { ingestion, repositories } = build();
  const created = [];
  const original = repositories.facescanRaw.createBatch;
  repositories.facescanRaw.createBatch = async (input) => {
    created.push(input);
    return original(input);
  };
  await assert.rejects(
    () => ingestion.ingestFile('facescan_id,scan_datetime\r\nFS-USER-001,2026-02-31 08:00'),
    (error) => error.status === 400 && error.code === 'FACESCAN_FILE_INVALID' && error.details.issues.length === 1,
  );
  assert.equal(created.length, 0);
});

test('ingestFile: mapped ids resolve, unknown ids are quarantined, a re-import adds nothing', async () => {
  const { ingestion, repositories } = build();
  const first = await ingestion.ingestFile(FILE, { sourceLabel: 'synthetic.csv' });
  assert.notEqual(first.batch.status, 'open', 'the returned batch is the committed one');
  assert.equal(first.batch.sourceSystem, 'hip_csv_export');
  assert.match(first.batch.sourceLabel, /^synthetic\.csv sha256:[0-9a-f]{64}$/);
  assert.equal(first.batch.insertedCount, 4);
  assert.equal(first.batch.resolvedCount, 3);
  assert.equal(first.batch.unmappedCount, 1);
  const quarantined = await repositories.facescanRaw.listUnmapped({});
  assert.deepEqual(quarantined.map((row) => row.facescanId), ['FS-UNKNOWN-777']);
  assert.equal(quarantined[0].employeeUid, null);

  const again = await ingestion.ingestFile(FILE, { sourceLabel: 'synthetic.csv' });
  assert.equal(again.batch.insertedCount, 0);
  assert.equal(again.batch.duplicateCount, 4);
  assert.equal(again.contentSha256, first.contentSha256);
  assert.equal(again.results.filter((row) => row.employeeUid === staffUid).length, 3);
  assert.equal(again.results[3].employeeUid, undefined, 'unmapped duplicates remain quarantined');
});

test('chain (fixture): file -> staging -> events -> daily -> monthly, in Bangkok time, no invented days', async () => {
  const { ingestion, repositories } = build();
  const { results } = await ingestion.ingestFile(FILE);
  const { rows: parsed } = parseFacescanCsvExport(FILE);

  // The fixture event repository reads its own staging copy; hand it exactly the rows the file
  // resolved (the MariaDB chain test reads staging_facescan_raw directly).
  const resolved = results
    .map((result, index) => ({ result, parsed: parsed[index] }))
    .filter(({ result }) => result.resolutionStatus === 'resolved')
    .map(({ result, parsed: row }) => ({
      id: result.id, importBatchUid: 'fixture', sourceSystem: 'hip_csv_export',
      sourceEventKey: result.idempotencyKey, facescanId: result.facescanId,
      checkTime: row.scanDatetime.replace(' ', 'T'), checkType: row.scanType, employeeUid: result.employeeUid,
    }));
  assert.equal(resolved.length, 3);
  assert.ok(resolved.every((row) => row.employeeUid === staffUid));
  repositories.attendanceEvents.seedResolvedStaging(resolved);

  const recordService = createAttendanceRecordService({ repositories });
  const derive = createFacescanAttendanceIngestionService({ repositories, recordService });
  const day = await derive.deriveDay(exec, staffUid, '2026-11-16');
  assert.equal(day.checkIn, '08:41');
  assert.equal(day.checkOut, '16:35');
  assert.equal(day.status, 'late');
  assert.equal(day.lateMinutes, 11);
  assert.equal(day.earlyMinutes, 0);
  assert.equal(day.ruleVersionCode, 'AR-0001');
  assert.equal(day.eventCount, 3);

  const stored = (await repositories.attendance.findForEmployee(staffUid)).find((row) => row.date === '2026-11-16');
  assert.equal(new Date(stored.checkIn).toISOString(), '2026-11-16T01:41:00.000Z');
  assert.equal(new Date(stored.firstEventAt).getTime(), new Date(stored.checkIn).getTime());
  assert.equal(new Date(stored.lastEventAt).getTime(), new Date(stored.checkOut).getTime());

  // A day without scans is not derived into anything, and nothing is ever ABSENT.
  await assert.rejects(() => derive.deriveDay(exec, staffUid, '2026-11-17'), { code: 'NO_FACESCAN_EVENTS' });
  const month = await repositories.attendance.findMonthly(staffUid, 2026, 11);
  assert.equal(month.totalAbsent, 0);
  assert.equal(day.monthly.totalLate >= 1, true);
});
