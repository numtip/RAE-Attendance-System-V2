// HIP daily-report adapter and the facescan:import operator CLI. Synthetic data only: the header mirrors
// the vendor layout, every code and name below is invented. TZ is UTC like the deploy containers.
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanRawIngestionService } = require('../src/services/facescanRawIngestionService');
const { parseHipDailyReport } = require('../src/imports/hipDailyReport');
const { runFacescanImport, EXIT } = require('../src/imports/facescanImportCli');

const adminUid = '11111111-1111-1111-1111-111111111111'; // fixture role 'admin': no data scope
const staffUid = '22222222-2222-2222-2222-222222222222'; // owns facescan_id FS-USER-001 in the fixtures

const HEADER = 'รหัสที่เครื่อง,ชื่อพนักงาน,แผนก,วัน/เวลา ,สถานะ,เวลาทำงาน{1},เข้า [1],ออก [1],สาย [1],ออกก่อน [1],Remark [1],';
const report = (...lines) => [HEADER, ...lines].join('\r\n');
const REPORT = report(
  'FS-USER-001,Synthetic Person,Synthetic Unit,16/11/2569,ปกติ,07:54,08:41,16:35,00:11,,มาสาย,',
  'FS-USER-001,Synthetic Person,Synthetic Unit,17/11/2569,ขาด,,,,,,,',
  'FS-UNKNOWN-777,Nobody,Synthetic Unit,16/11/2569,ปกติ,08:00,08:00,16:30,,,,',
);

function build({ operatorRole = 'admin', grant = false } = {}) {
  const repositories = createFixtureRepositories();
  const findByUid = repositories.employees.findByUid.bind(repositories.employees);
  repositories.employees.findByUid = async (uid) => {
    const employee = await findByUid(uid);
    return employee && uid === adminUid ? { ...employee, role: operatorRole } : employee;
  };
  // The fixture event repository reads its own staging copy (see facescanFileIngestion.test.js); mirror
  // every resolved insert into it so the CLI's derive step sees what the import wrote.
  const insertRawRow = repositories.facescanRaw.insertRawRow.bind(repositories.facescanRaw);
  const mirrored = [];
  repositories.facescanRaw.insertRawRow = async (input) => {
    const row = await insertRawRow(input);
    if (input.resolutionStatus === 'resolved') {
      mirrored.push({
        id: row.id, importBatchUid: input.batchId, sourceSystem: input.sourceSystem,
        sourceEventKey: input.idempotencyKey, facescanId: input.facescanId,
        checkTime: input.scanDatetime.replace(' ', 'T'), checkType: input.scanType, employeeUid: input.employeeUid,
      });
      repositories.attendanceEvents.seedResolvedStaging(mirrored);
    }
    return row;
  };
  repositories.authorization = {
    async grantsFor(uid) {
      return grant && uid === adminUid ? [{ employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' }] : [];
    },
    async uidsInOrgUnits() {
      return [];
    },
  };
  return repositories;
}

const run = (argv, repositories, dataSource = 'mariadb') => runFacescanImport(argv, {
  container: { dataSource, repositories },
  readFile: async () => Buffer.from(REPORT, 'utf8'),
});

test('adapter: slot times become in/out rows; names and report columns are dropped', () => {
  const { rows, summary } = parseHipDailyReport(Buffer.from(`\uFEFF${REPORT}`, 'utf8'));
  assert.deepEqual(summary, { reportRows: 3, daysWithScans: 2, daysWithoutScans: 1 });
  assert.deepEqual(rows[0], {
    facescanId: 'FS-USER-001',
    scanDatetime: '2026-11-16 08:41:00', // BE 2569 -> CE 2026, Bangkok wall clock
    scanType: 'in',
    payload: { sourceLine: 2, origin: 'report_derived', slot: 1, kind: 'in' },
  });
  assert.equal(rows[1].scanDatetime, '2026-11-16 16:35:00');
  assert.equal(rows[1].scanType, 'out');
  assert.equal(rows.length, 4, 'the day without times creates no row');
  const serialized = JSON.stringify(rows);
  for (const dropped of ['Synthetic Person', 'Synthetic Unit', 'มาสาย', '00:11', '07:54']) {
    assert.equal(serialized.includes(dropped), false, dropped);
  }
});

test('adapter: every slot pair is read', () => {
  const header = 'รหัสที่เครื่อง,วัน/เวลา,เข้า [1],ออก [1],เข้า [2],ออก [2]';
  const { rows } = parseHipDailyReport(`${header}\nFS-USER-001,16/11/2569,08:30,12:00,13:00,16:30`);
  assert.deepEqual(rows.map((row) => `${row.payload.slot}${row.scanType}`), ['1in', '1out', '2in', '2out']);
});

test('adapter: fails closed on the whole file', () => {
  const refused = (text, pattern) => assert.throws(() => parseHipDailyReport(text), pattern);
  refused('facescan_id,scan_datetime\nX,2026-11-16 08:00', /not a HIP daily report/);
  refused('รหัสที่เครื่อง,วัน/เวลา,เข้า [1]\nX,16/11/2569,08:00', /needs both/);
  refused(report('X,,,16/11/2026,,,08:00,16:00,,,,'), (error) => error.issues[0].message.includes('Buddhist-era'));
  refused(report('X,,,31/04/2569,,,08:00,16:00,,,,'), (error) => error.issues[0].message.includes('Buddhist-era'));
  refused(report('X,,,16/11/2569 08:00,,,08:00,16:00,,,,'), (error) => error.issues[0].message.includes('Buddhist-era'));
  refused(report('X,,,16/11/2569,,,8.30,16:00,,,,'), (error) => error.issues[0].message.includes('HH:MM'));
  refused(report('X,,,16/11/2569,,,16:00,08:00,,,,'), (error) => error.issues[0].message.includes('earlier'));
  refused(report(',,,16/11/2569,,,08:00,16:00,,,,'), (error) => error.issues[0].message.includes('empty'));
  refused(report('X,,,16/11/2569,,,08:00,,,,,', 'X,,,16/11/2569,,,09:00,,,,,'), (error) => error.issues[0].message.includes('same code and date'));
  refused(report('X,,,16/11/2569,,,,,,,,'), /no scan times/);
  refused(Buffer.from([0x41, 0xff, 0xfe]), /not UTF-8/);
});

test('service: preview writes nothing; import stamps report provenance; replay adds 0 rows', async () => {
  const repositories = build();
  const ingestion = createFacescanRawIngestionService({ repositories });

  const preview = await ingestion.previewFile(REPORT, { format: 'hip_daily_report' });
  assert.equal(preview.sourceSystem, 'hip_daily_report');
  assert.deepEqual(
    [preview.scanRows, preview.newResolved, preview.newUnmapped, preview.alreadyImported, preview.unmappedCodes],
    [4, 2, 2, 0, 1],
  );
  assert.deepEqual([preview.dateFrom, preview.dateTo], ['2026-11-16', '2026-11-16']);
  assert.equal(JSON.stringify(preview).includes('FS-'), false, 'aggregates only');
  assert.equal((await repositories.facescanRaw.listUnmapped({})).length, 0, 'a preview inserts nothing');

  const first = await ingestion.ingestFile(REPORT, { format: 'hip_daily_report', sourceLabel: 'synthetic' });
  assert.equal(first.batch.sourceSystem, 'hip_daily_report', 'report-derived, not device punches');
  const stored = await repositories.facescanRaw.findByIdempotencyKey(first.results[0].idempotencyKey);
  // The row-level source_system copy is ingestBatch's (MariaDB-covered); the fixture keeps the payload.
  assert.equal(stored.payloadJson.origin, 'report_derived');

  const again = await ingestion.previewFile(REPORT, { format: 'hip_daily_report' });
  assert.equal(again.alreadyImported, 4);
  const replay = await ingestion.ingestFile(REPORT, { format: 'hip_daily_report' });
  assert.ok(replay.results.every((result) => result.resolutionStatus === 'duplicate'));
});

test('cli: dry run by default; --format is required; writes need mariadb', async () => {
  const repositories = build();
  const dry = await run(['report.csv', '--format', 'hip-daily'], repositories);
  assert.equal(dry.exitCode, EXIT.OK);
  assert.equal(dry.report.mode, 'dry-run');
  assert.equal(dry.report.written, false);
  assert.equal((await repositories.facescanRaw.listUnmapped({})).length, 0);

  assert.equal((await run(['report.csv'], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['report.csv', '--format', 'pm2014'], repositories)).exitCode, EXIT.USAGE);
  const fixture = await run(['report.csv', '--format', 'hip-daily', '--confirm'], repositories, 'fixture');
  assert.equal(fixture.exitCode, EXIT.USAGE);
  assert.match(fixture.report.refused, /DATA_SOURCE=mariadb/);
  assert.equal((await run(['r.csv', '--format', 'hip-daily', '--derive', '--operator', adminUid], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['r.csv', '--format', 'hip-daily', '--confirm', '--derive'], repositories)).exitCode, EXIT.USAGE);
});

test('cli: an operator without data scope is refused before anything is written', async () => {
  const repositories = build({ operatorRole: 'admin' });
  const refused = await run(['r.csv', '--format', 'hip-daily', '--confirm', '--derive', '--operator', adminUid], repositories);
  assert.equal(refused.exitCode, EXIT.NOT_AUTHORISED);
  assert.equal((await repositories.facescanRaw.listUnmapped({})).length, 0, 'no batch, no staging row');
});

test('cli: --confirm --derive imports, quarantines the unknown code and records the resolved day', async () => {
  const repositories = build({ operatorRole: 'executive', grant: true });
  const result = await run(['r.csv', '--format', 'hip-daily', '--confirm', '--derive', '--operator', adminUid], repositories);
  assert.equal(result.exitCode, EXIT.OK, JSON.stringify(result.report));
  assert.equal(result.report.sourceSystem, 'hip_daily_report');
  assert.deepEqual(result.report.rows, { resolved: 2, unmapped: 2 });
  assert.deepEqual(result.report.derive, { employeeDays: 1, outcomes: { recorded: 1 } });
  assert.equal(JSON.stringify(result.report).includes('FS-'), false, 'aggregates only');

  const day = (await repositories.attendance.findForEmployee(staffUid)).find((row) => row.date === '2026-11-16');
  assert.equal(new Date(day.checkIn).toISOString(), '2026-11-16T01:41:00.000Z', '08:41 Bangkok');
  assert.equal(new Date(day.checkOut).toISOString(), '2026-11-16T09:35:00.000Z', '16:35 Bangkok');

  const replay = await run(['r.csv', '--format', 'hip-daily', '--confirm', '--derive', '--operator', adminUid], repositories);
  assert.equal(replay.exitCode, EXIT.OK);
  assert.deepEqual(replay.report.rows, { duplicate: 4 });
  assert.deepEqual(replay.report.derive, { employeeDays: 0, outcomes: {} });
});
