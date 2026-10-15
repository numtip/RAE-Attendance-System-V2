const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFacescanCsvIngestionService } = require('../src/services/facescanCsvIngestionService');
const {
  CSV_PARSER_VERSION,
  CHECKINOUT_COLUMNS,
  REQUIRED_COLUMNS,
  parseCsv,
  resolveColumnMap,
  assertRequiredColumns,
  toCheckinoutRows,
} = require('../src/domain/facescanCsv');
const { buildSourceEventKey, normalizeCheckinoutRow } = require('../src/domain/facescanIngestion');

const NAME_VALUE = 'ZZZ-NAME-VALUE';
const BADGE_VALUE = 'ZZZ-BADGE-9';

function ctx() {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    service: createFacescanCsvIngestionService({ repositories }),
  };
}

/** Wraps createBatch so a test can assert whether a batch was ever created. */
function trackBatches(repositories) {
  let count = 0;
  const store = repositories.facescanIngestion;
  const original = store.createBatch;
  store.createBatch = async (input) => {
    count += 1;
    return original.call(store, input);
  };
  return () => count;
}

const HIP_CSV = [
  'USERID,CHECKTIME,CHECKTYPE,VERIFYCODE,SensorID,WorkCode,Name,Badgenumber',
  `FS-USER-001,2026-09-01 08:00:00,I,1,S1,0,${NAME_VALUE},${BADGE_VALUE}`,
  `FS-USER-001,2026-09-01 08:00:00,I,1,S1,0,${NAME_VALUE},${BADGE_VALUE}`,
  `FS-UNKNOWN-404,2026-09-01 09:00:00,I,1,S2,0,${NAME_VALUE},${BADGE_VALUE}`,
].join('\r\n').concat('\r\n');

test('parseCsv strips a leading UTF-8 BOM', () => {
  const parsed = parseCsv('\uFEFFUSERID,CHECKTIME\nFS-0001,2026-09-01 08:00:00\n');
  assert.deepEqual(parsed.header, ['USERID', 'CHECKTIME']);
  assert.deepEqual(parsed.rows, [['FS-0001', '2026-09-01 08:00:00']]);
});

test('parseCsv handles CRLF, LF and a trailing newline identically', () => {
  const crlf = parseCsv('USERID,CHECKTIME\r\nFS-0001,2026-09-01 08:00:00\r\n');
  const lf = parseCsv('USERID,CHECKTIME\nFS-0001,2026-09-01 08:00:00\n');
  assert.deepEqual(crlf.rows, lf.rows);
  assert.deepEqual(crlf.rows, [['FS-0001', '2026-09-01 08:00:00']]);
  assert.deepEqual(crlf.lineNumbers, [2]);
});

test('parseCsv keeps a delimiter inside a quoted field', () => {
  const parsed = parseCsv('USERID,CHECKTYPE\nFS-0001,"I,EXTRA"\n');
  assert.deepEqual(parsed.rows[0], ['FS-0001', 'I,EXTRA']);
});

test('parseCsv keeps an embedded newline inside quotes without corrupting line numbers', () => {
  const parsed = parseCsv('USERID,CHECKTIME\nFS-0001,"2026-09-01\n08:00:00"\nFS-0002,2026-09-01 09:00:00\n');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][1], '2026-09-01\n08:00:00');
  assert.deepEqual(parsed.lineNumbers, [2, 4]);
});

test('parseCsv turns doubled quotes into one quote', () => {
  const parsed = parseCsv('USERID,CHECKTIME\n"FS-""0001""",2026-09-01 08:00:00\n');
  assert.equal(parsed.rows[0][0], 'FS-"0001"');
});

test('parseCsv skips fully blank lines and trims unquoted cells', () => {
  const parsed = parseCsv('USERID,CHECKTIME\n\nFS-0001, 2026-09-01 08:00:00 \n\n   \nFS-0002,2026-09-01 09:00:00');
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], ['FS-0001', '2026-09-01 08:00:00']);
  assert.deepEqual(parsed.lineNumbers, [3, 6]);
});

test('parseCsv throws CSV_EMPTY when there is no header or no data row', () => {
  assert.throws(() => parseCsv(''), (err) => err.status === 400 && err.code === 'CSV_EMPTY');
  assert.throws(() => parseCsv('   \n  \n'), (err) => err.code === 'CSV_EMPTY');
  assert.throws(() => parseCsv('USERID,CHECKTIME\n'), (err) => err.code === 'CSV_EMPTY');
});

test('parseCsv throws CSV_UNTERMINATED_QUOTE for an unterminated field', () => {
  assert.throws(
    () => parseCsv('USERID,CHECKTIME\nFS-0001,"2026-09-01 08:00:00\n'),
    (err) => err.status === 400 && err.code === 'CSV_UNTERMINATED_QUOTE',
  );
});

test('resolveColumnMap matches case-insensitively after trimming', () => {
  const { map, missing, ignoredHeaders } = resolveColumnMap([' userid ', 'CheckTime', 'Name']);
  assert.equal(map.facescanId, 'userid');
  assert.equal(map.checkTime, 'CheckTime');
  assert.deepEqual(missing, []);
  assert.deepEqual(ignoredHeaders, ['Name']);
});

test('resolveColumnMap prefers the first alias in alias order', () => {
  const { map } = resolveColumnMap(['facescanId', 'USERID', 'CHECKTIME']);
  assert.equal(map.facescanId, 'USERID');
});

test('resolveColumnMap overrides pin an exact header name', () => {
  const resolved = resolveColumnMap(['Badgenumber', 'CHECKTIME'], {
    overrides: { facescanId: 'Badgenumber' },
  });
  assert.equal(resolved.map.facescanId, 'Badgenumber');
  assert.deepEqual(resolved.missing, []);
});

test('resolveColumnMap reports missing required columns as canonical names', () => {
  const { missing } = resolveColumnMap(['Name', 'Dept']);
  assert.deepEqual(missing, ['facescanId', 'checkTime']);
});

test('assertRequiredColumns throws CSV_HEADER_MISSING exposing canonical names only', () => {
  const error = (() => {
    try {
      assertRequiredColumns(['Name', 'Dept']);
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.equal(error.status, 400);
  assert.equal(error.code, 'CSV_HEADER_MISSING');
  assert.deepEqual(error.details.missing, ['facescanId', 'checkTime']);
  assert.ok(!error.message.includes('Name'));
  assert.ok(!error.message.includes('Dept'));
  assert.ok(JSON.stringify(error.details).includes('facescanId'));
});

test('toCheckinoutRows drops extra CSV columns and only emits the six fields', () => {
  const parsed = parseCsv(`USERID,CHECKTIME,CHECKTYPE,VERIFYCODE,SensorID,WorkCode,Name\nFS-0001,2026-09-01 08:00:00,I,1,S1,0,${NAME_VALUE}\n`);
  const { map } = resolveColumnMap(parsed.header);
  const { rows } = toCheckinoutRows({ header: parsed.header, rows: parsed.rows, map });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['CHECKTIME', 'CHECKTYPE', 'SensorID', 'USERID', 'VERIFYCODE', 'WorkCode'].sort());
  assert.equal(rows[0].USERID, 'FS-0001');
  assert.equal(JSON.stringify(rows).includes(NAME_VALUE), false);
});

test('toCheckinoutRows skips a blank required cell with missing_required_value', () => {
  const parsed = parseCsv('USERID,CHECKTIME\n,2026-09-01 08:00:00\nFS-0002,2026-09-01 09:00:00\n');
  const { map } = resolveColumnMap(parsed.header);
  const { rows, skipped } = toCheckinoutRows({
    header: parsed.header,
    rows: parsed.rows,
    map,
    lineNumbers: parsed.lineNumbers,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(skipped, [{ lineNumber: 2, reason: 'missing_required_value' }]);
});

test('toCheckinoutRows throws CSV_TOO_LARGE past maxRows', () => {
  assert.throws(
    () => toCheckinoutRows({
      header: ['USERID', 'CHECKTIME'],
      rows: [['FS-0001', '2026-09-01 08:00:00'], ['FS-0002', '2026-09-01 08:00:00']],
      map: { facescanId: 'USERID', checkTime: 'CHECKTIME' },
      maxRows: 1,
    }),
    (err) => err.status === 400 && err.code === 'CSV_TOO_LARGE' && err.details.maxRows === 1,
  );
});

test('domain constants stay frozen and aligned with the normalizer aliases', () => {
  assert.equal(CSV_PARSER_VERSION, 'facescan-csv/v1');
  assert.ok(Object.isFrozen(CHECKINOUT_COLUMNS));
  assert.ok(Object.isFrozen(REQUIRED_COLUMNS));
  assert.equal(CHECKINOUT_COLUMNS.facescanId[0], 'USERID');
  assert.equal(CHECKINOUT_COLUMNS.checkTime[0], 'CHECKTIME');
});

test('inspectCsv hashing is stable for the same text and differs for different text', async () => {
  const { service } = ctx();
  const text = 'USERID,CHECKTIME\nFS-0001,2026-09-01 08:00:00\n';
  const a = await service.inspectCsv({ text, fileName: 'a.csv' });
  const b = await service.inspectCsv({ text, fileName: 'b.csv' });
  const c = await service.inspectCsv({ text: 'USERID,CHECKTIME\nFS-0001,2026-09-01 08:00:01\n' });
  assert.equal(a.inputSha256, b.inputSha256);
  assert.notEqual(a.inputSha256, c.inputSha256);
  assert.equal(a.byteLength, Buffer.byteLength(text, 'utf8'));
  assert.equal(a.parserVersion, CSV_PARSER_VERSION);
});

test('inspectCsv counts rows, invalids, duplicates and window, and reduces the file name', async () => {
  const { service } = ctx();
  const csv = [
    'USERID,CHECKTIME,CHECKTYPE,VERIFYCODE,SensorID,WorkCode,Name',
    `FS-0001,2026-09-01 08:00:00,I,1,S1,0,${NAME_VALUE}`,
    `FS-0001,2026-09-01 08:00:00,I,1,S1,0,${NAME_VALUE}`,
    `FS-0002,not-a-date,I,1,S2,0,${NAME_VALUE}`,
    `FS-0003,2026-09-02 17:00:00,O,1,S3,0,${NAME_VALUE}`,
    `,2026-09-03 08:00:00,I,1,S4,0,${NAME_VALUE}`,
  ].join('\r\n').concat('\r\n');
  const report = await service.inspectCsv({ text: csv, fileName: 'C:\\tmp\\june.csv' });
  assert.equal(report.fileName, 'june.csv');
  assert.equal(report.rowCount, 5);
  assert.equal(report.acceptedCount, 4);
  assert.equal(report.skippedCount, 1);
  assert.equal(report.invalidCount, 1);
  assert.equal(report.invalid[0].reason, 'invalid_checktime');
  assert.equal(report.invalid[0].lineNumber, 4);
  assert.equal(report.inFileDuplicateCount, 1);
  assert.deepEqual(report.duplicateLineNumbers, [3]);
  assert.equal(report.windowFrom, '2026-09-01 08:00:00');
  assert.equal(report.windowTo, '2026-09-02 17:00:00');
  assert.equal(report.ignoredHeaders.includes('Name'), true);
  assert.equal(JSON.stringify(report).includes(NAME_VALUE), false);
});

test('ingestCsv dry run (default) writes nothing', async () => {
  const { repositories, service } = ctx();
  const batchCount = trackBatches(repositories);
  const result = await service.ingestCsv({ text: HIP_CSV, fileName: 'hip.csv' });
  assert.equal(result.dryRun, true);
  assert.equal(batchCount(), 0);
  const key = buildSourceEventKey(normalizeCheckinoutRow({
    USERID: 'FS-USER-001',
    CHECKTIME: '2026-09-01 08:00:00',
    CHECKTYPE: 'I',
    VERIFYCODE: '1',
    SensorID: 'S1',
    WorkCode: '0',
  }));
  assert.equal(await repositories.facescanIngestion.findBySourceEventKey(key), null);
});

test('ingestCsv real run creates one batch with provenance and stores rows', async () => {
  const { service } = ctx();
  const result = await service.ingestCsv({ text: HIP_CSV, fileName: 'C:\\tmp\\hip.csv', dryRun: false });
  assert.equal(result.dryRun, false);
  assert.equal(result.batch.sourceType, 'checkinout');
  assert.equal(result.batch.fileName, 'hip.csv');
  assert.equal(result.batch.inputSha256, result.report.inputSha256);
  assert.equal(result.batch.parserVersion, CSV_PARSER_VERSION);
  // Provenance records the mapping that was ACTUALLY applied, not the (empty) caller override.
  assert.equal(result.batch.columnMapJson, JSON.stringify(result.report.columnMap));
  assert.equal(JSON.parse(result.batch.columnMapJson).facescanId, 'USERID');
  assert.equal(JSON.parse(result.batch.columnMapJson).checkTime, 'CHECKTIME');
  assert.equal(result.batch.rowsRead, 3);
  assert.equal(result.batch.rowsInserted, 2);
  assert.equal(result.batch.rowsDuplicate, 1);
  assert.equal(result.batch.rowsUnmapped, 1);
});

test('ingestCsv is idempotent: the same file re-imports as duplicates', async () => {
  const { service } = ctx();
  await service.ingestCsv({ text: HIP_CSV, fileName: 'hip.csv', dryRun: false });
  const second = await service.ingestCsv({ text: HIP_CSV, fileName: 'hip.csv', dryRun: false });
  assert.equal(second.batch.rowsInserted, 0);
  assert.equal(second.batch.rowsDuplicate, 3);
  assert.equal(second.batch.rowsUnmapped, 0);
});

test('ingestCsv throws before a batch exists when the header is missing', async () => {
  const { repositories, service } = ctx();
  const batchCount = trackBatches(repositories);
  await assert.rejects(
    service.ingestCsv({ text: `Name,Badgenumber\n${NAME_VALUE},${BADGE_VALUE}\n`, fileName: 'bad.csv', dryRun: false }),
    (err) => err.status === 400 && err.code === 'CSV_HEADER_MISSING',
  );
  assert.equal(batchCount(), 0);
});

test('reports never leak a name or badge value from the CSV', async () => {
  const { service } = ctx();
  const report = await service.inspectCsv({ text: HIP_CSV, fileName: 'hip.csv' });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(NAME_VALUE), false);
  assert.equal(serialized.includes(BADGE_VALUE), false);
});
