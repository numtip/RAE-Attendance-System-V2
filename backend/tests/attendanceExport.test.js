/**
 * R-03 attendance report export — service and API level (fixture repositories, no database).
 *
 * The suite is built around the two things a reader must be able to trust:
 *
 *   1. the numbers in an artifact ARE the numbers R-02 reports (the export derives nothing), and
 *   2. an incomplete report can never leave the service looking final (watermark, DRAFT banner, status).
 *
 * The artifacts are read back INDEPENDENTLY of the code that wrote them: the XLSX is unzipped with
 * `node:zlib` and the sheet XML is parsed as XML here, and the PDF text layer is decoded from the embedded
 * `ToUnicode` CMaps. Nothing in this file trusts `xlsxWriter`/`pdfRenderer` to describe itself.
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

require('./helpers/syntheticIdentifierKeys');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createDailyAttendanceService } = require('../src/services/dailyAttendanceService');
const { createMonthlySummaryService } = require('../src/services/monthlySummaryService');
const { createAttendanceReportService } = require('../src/services/attendanceReportService');
const { createExportService } = require('../src/services/exportService');
const { TOTALS_LABELS, safeExportFileName, formatThaiDate } = require('../src/domain/attendanceReportPresentation');
const { createApp } = require('../src/app');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const ADMIN_AUTH = { employeeUid: USER_UID, role: 'admin' };
const FIXED_NOW = () => new Date('2026-10-16T04:16:45.000Z');
const DRAFT_TEXT = 'ข้อมูลยังไม่สมบูรณ์';

let scanCounter = 0;

// --- fixtures (synthetic only) --------------------------------------------------------------

async function addScan(repositories, { employeeUid, eventTime, checkType }) {
  scanCounter += 1;
  return repositories.attendanceEvents.insert({
    employeeUid,
    stagingFacescanRawId: 7000 + scanCounter,
    importBatchUid: 'batch-export',
    sourceSystem: 'hip_pm2014',
    sourceEventKey: `export-${scanCounter}`.padEnd(64, '0'),
    sourceType: 'facescan_checkinout',
    facescanId: 'FS-EXPORT',
    eventTime,
    checkType,
    verifyCode: '1',
    sensorId: 'S1',
    workCode: null,
    timezoneLabel: 'Asia/Bangkok',
  });
}

function dayRow(overrides = {}) {
  return {
    employeeUid: USER_UID,
    date: '2026-03-03',
    checkIn: null,
    checkOut: null,
    isLate: false,
    lateMinutes: 0,
    earlyMinutes: 0,
    workDuration: 0,
    isLeave: false,
    leaveType: null,
    status: 'pending',
    notes: 'synthetic',
    sourceSystem: null,
    ruleVersionCode: 'AR-0001',
    scheduleCode: null,
    computationStatus: 'insufficient_data',
    dayClassification: 'workday',
    isOvernight: false,
    sourceEventCount: 1,
    firstEventAt: null,
    lastEventAt: null,
    calculatedAt: '2026-03-03T00:00:00.000Z',
    reconciliationJson: { reason: 'single_scan_only' },
    sourceEventIds: [],
    ...overrides,
  };
}

/** March 2026: Mon late, Tue on time, Wed early, Thu/Fri absent, Sun non-working. */
async function populateMarch(repositories) {
  const daily = createDailyAttendanceService({ repositories });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-02 08:45:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-02 16:30:00', checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 08:00:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 17:00:00', checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 08:30:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 15:30:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2026-03-01', to: '2026-03-06' });
  return createMonthlySummaryService({ repositories, now: FIXED_NOW })
    .recalculateMonth(ADMIN_AUTH, USER_UID, 2026, 3);
}

/** A month whose stored row says an approval is missing, derived from one unapproved-policy day. */
async function populatePendingPolicyMonth(repositories, year, month) {
  const daily = createDailyAttendanceService({ repositories });
  const day = `${year}-${String(month).padStart(2, '0')}-01`;
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${day} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${day} 16:30:00`, checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: day, to: day });
  return createMonthlySummaryService({ repositories, now: FIXED_NOW })
    .recalculateMonth(ADMIN_AUTH, USER_UID, year, month);
}

/** One unjudged day inside an otherwise derived month, which makes the month `partial`. */
async function populatePartialMonth(repositories) {
  const daily = createDailyAttendanceService({ repositories });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-02 08:45:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-02 16:30:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2026-03-02', to: '2026-03-02' });
  await repositories.dailyAttendance.upsertDay(dayRow({ date: '2026-03-03' }));
  return createMonthlySummaryService({ repositories, now: FIXED_NOW })
    .recalculateMonth(ADMIN_AUTH, USER_UID, 2026, 3);
}

function exportService(repositories) {
  return createExportService({ repositories, now: FIXED_NOW });
}

function reportService(repositories) {
  return createAttendanceReportService({ repositories, now: FIXED_NOW });
}

// --- reading an artifact without trusting the writer ------------------------------------------

/** Local file headers only: we never set the data-descriptor flag, so sizes are always in the header. */
function zipEntries(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, uncompressedSize, `${name} length must match the header`);
    entries[name] = data;
    offset = dataStart + compressedSize;
  }
  return entries;
}

function columnIndex(letters) {
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse a sheet part into rows of cell values; numbers come back as numbers, texts as strings. */
function parseSheet(xml) {
  const byRow = new Map();
  for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const column = columnIndex(match[1]);
    const rowNumber = Number(match[2]);
    const inner = match[4];
    let value;
    if (match[3].includes('t="inlineStr"')) {
      const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      value = text ? unescapeXml(text[1]) : '';
    } else {
      const number = /<v>([\s\S]*?)<\/v>/.exec(inner);
      value = number ? Number(number[1]) : null;
    }
    if (!byRow.has(rowNumber)) byRow.set(rowNumber, []);
    byRow.get(rowNumber)[column] = value;
  }
  return [...byRow.keys()].sort((a, b) => a - b).map((rowNumber) => {
    const cells = byRow.get(rowNumber);
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index] === undefined) cells[index] = null;
    }
    return { rowNumber, cells };
  });
}

/** `{ sheetName: rows }` for an .xlsx buffer, read through the real ZIP container. */
function readWorkbook(buffer) {
  const entries = zipEntries(buffer);
  const workbook = entries['xl/workbook.xml'].toString('utf8');
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => unescapeXml(match[1]));
  assert.ok(names.length > 0, 'the workbook must declare at least one sheet');
  const sheets = {};
  names.forEach((name, index) => {
    const part = entries[`xl/worksheets/sheet${index + 1}.xml`];
    assert.ok(part, `worksheet part for ${name} must exist`);
    sheets[name] = parseSheet(part.toString('utf8'));
  });
  return { names, sheets, xml: entries, rawWorkbookXml: workbook };
}

/** The two-column summary sheet as label -> value. */
function summaryValues(rows) {
  const values = {};
  for (const row of rows) {
    if (row.cells.length < 2 || row.cells[0] == null || row.cells[1] == null) continue;
    values[String(row.cells[0])] = row.cells[1];
  }
  return values;
}

function headerRowOf(rows, firstCell) {
  const index = rows.findIndex((row) => row.cells[0] === firstCell);
  assert.notEqual(index, -1, `the table header starting with ${firstCell} must exist`);
  return index;
}

/**
 * The decoded XML of every part in the package. Searching the raw .xlsx buffer would be a false negative:
 * the parts are DEFLATE-compressed, so a Thai string is not a byte run in the file.
 */
function artifactText(buffer) {
  return Object.values(zipEntries(buffer)).map((entry) => entry.toString('utf8')).join('\n');
}

/** Whitespace-insensitive containment: PDF text runs drop the space glyphs that separated the same line. */
function squeezeIncludes(text, needle) {
  return text.replace(/\s+/g, '').includes(String(needle).replace(/\s+/g, ''));
}

// --- PDF text layer, decoded through the embedded ToUnicode CMaps ------------------------------

function pdfObjects(buffer) {
  const text = buffer.toString('latin1');
  const objects = new Map();
  for (const match of text.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) objects.set(Number(match[1]), match[2]);
  return objects;
}

function inflateStream(body) {
  if (!body) return null;
  const start = body.indexOf('stream');
  if (start === -1) return null;
  let index = start + 'stream'.length;
  if (body[index] === '\r') index += 1;
  if (body[index] === '\n') index += 1;
  const raw = Buffer.from(body.slice(index, body.lastIndexOf('endstream')), 'latin1');
  if (!body.slice(0, start).includes('FlateDecode')) return raw;
  try {
    return zlib.inflateSync(raw);
  } catch {
    return raw;
  }
}

function hexToUnicode(hex) {
  let out = '';
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

function parseCMap(text) {
  const map = new Map();
  for (const [, block] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToUnicode(pair[2]));
    }
  }
  for (const [, block] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    for (const item of block.matchAll(re)) {
      const low = parseInt(item[1], 16);
      const high = parseInt(item[2], 16);
      if (item[3]) {
        const base = hexToUnicode(item[3]);
        for (let code = low; code <= high; code += 1) {
          const last = base.charCodeAt(base.length - 1) + (code - low);
          map.set(code, `${base.slice(0, -1)}${String.fromCharCode(last)}`);
        }
      } else {
        [...item[4].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((entry, index) => {
          map.set(low + index, hexToUnicode(entry[1]));
        });
      }
    }
  }
  return map;
}

/**
 * The PDF text layer, decoded from the content streams via each font's ToUnicode CMap.
 *
 * KNOWN LIMITATION: a Thai word containing U+0E33 SARA AM comes back decomposed (ทำงาน -> ทำางาน) because that
 * is what pdfkit's CMap says. Assertions below therefore use Thai needles WITHOUT U+0E33, and the digits,
 * Latin text and the `DRAFT` label extract exactly.
 */
function extractPdfText(buffer) {
  const objects = pdfObjects(buffer);
  const fontObjects = {};
  for (const body of objects.values()) {
    const resources = /\/Font\s*<<([^>]*)>>/.exec(body);
    if (!resources) continue;
    for (const entry of resources[1].matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) fontObjects[entry[1]] = Number(entry[2]);
  }
  const cmaps = {};
  for (const [name, number] of Object.entries(fontObjects)) {
    const unicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(objects.get(number) || '');
    if (!unicode) continue;
    const stream = inflateStream(objects.get(Number(unicode[1])));
    if (stream) cmaps[name] = parseCMap(stream.toString('latin1'));
  }
  assert.ok(Object.keys(cmaps).length > 0, 'the PDF must carry an embedded font with a ToUnicode CMap');

  let out = '';
  for (const body of objects.values()) {
    const data = inflateStream(body);
    if (!data) continue;
    const content = data.toString('latin1');
    if (!content.includes('BT')) continue;
    let font = null;
    const tokens = /\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>/g;
    let token;
    while ((token = tokens.exec(content)) !== null) {
      if (token[1]) {
        font = token[1];
        continue;
      }
      if (!font || !cmaps[font]) continue;
      const hex = token[2];
      for (let index = 0; index + 4 <= hex.length; index += 4) {
        out += cmaps[font].get(parseInt(hex.slice(index, index + 4), 16)) ?? '';
      }
    }
  }
  return out;
}

function pdfPageCount(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

const squeeze = (text) => text.replace(/\s+/g, '');

// --- 1. the exported numbers ARE the R-02 numbers ----------------------------------------------

test('every exported number equals the R-02 payload exactly, in both formats', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const direct = await reportService(repositories).monthReport(ADMIN_AUTH, USER_UID, 2026, 3);

  const service = exportService(repositories);
  const xlsx = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'xlsx',
  });
  const pdf = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'pdf',
  });

  // The payload travelling with the artifact is byte-for-byte the report a reader gets from R-02, so the
  // export provably derives nothing of its own.
  assert.deepEqual(xlsx.report, direct);
  assert.deepEqual(pdf.report, direct);
  assert.equal(direct.report.isFinal, true, 'the fixture states for this test must be a final report');

  const { sheets } = readWorkbook(xlsx.buffer);
  const values = summaryValues(sheets['สรุป']);
  const pdfText = squeeze(extractPdfText(pdf.buffer));

  for (const [field, label] of TOTALS_LABELS) {
    const expected = direct.month[field];
    const cell = values[label];
    assert.equal(typeof cell, 'number', `${label} must be exported as a NUMBER, got ${typeof cell}`);
    assert.equal(cell, expected, `${label} must equal the R-02 value`);
    assert.ok(pdfText.includes(String(expected)), `${field} (${expected}) must appear in the PDF text layer`);
  }
  // A number that is not an integer must not lose precision (23.75 is the March 2026 total).
  assert.equal(values[TOTALS_LABELS[7][1]], 23.75);
  assert.equal(values[TOTALS_LABELS[8][1]], 22);

  // Per-day figures in the day table must match the R-02 day array, day by day.
  const dayRows = sheets['รายวัน'];
  const header = headerRowOf(dayRows, 'วันที่');
  const byDate = new Map(dayRows.slice(header + 1).map((row) => [String(row.cells[0]), row.cells]));
  assert.equal(byDate.size, direct.days.length, 'one exported row per R-02 day');
  for (const day of direct.days) {
    const cells = byDate.get(formatThaiDate(day.date, { short: true }));
    assert.ok(cells, `${day.date} must have a row in the day table`);
    assert.equal(cells[4], day.lateMinutes, `${day.date} late minutes`);
    assert.equal(cells[5], day.workDuration, `${day.date} work duration`);
  }

  // Provenance the milestone requires must be visible in the artifact itself, not only in the payload.
  assert.equal(values['สถานะการคำนวณ (computationStatus)'], 'คำนวณแล้ว (calculated)');
  assert.equal(values['สรุปเป็นผลสรุปได้ (isFinal)'], 'ใช่ (true)');
  assert.equal(values['วันที่ตัดข้อมูล (dateCutoff)'], formatThaiDate(direct.report.dateCutoff));
  assert.equal(values['เวอร์ชันกฎที่ใช้ (ruleVersions)'], direct.report.ruleVersions.join(', '));
  assert.match(values['ประชากรของรายงาน (population)'], new RegExp(String(direct.report.population.dayRows)));
  assert.equal(pdfPageCount(pdf.buffer) > 0, true);
});

// --- 2. the honesty gate -----------------------------------------------------------------------

test('a partial month is watermarked in both formats', async () => {
  const repositories = createFixtureRepositories();
  await populatePartialMonth(repositories);
  const service = exportService(repositories);
  const xlsx = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'xlsx',
  });
  const pdf = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'pdf',
  });

  assert.equal(xlsx.report.report.computationStatus, 'partial');
  assert.equal(xlsx.report.report.isFinal, false);
  const xml = artifactText(xlsx.buffer);
  assert.ok(xml.includes('DRAFT — ข้อมูลยังไม่สมบูรณ์'), 'the XLSX banner row must carry DRAFT + the Thai text');

  const pdfText = extractPdfText(pdf.buffer);
  assert.ok(pdfText.includes('DRAFT'), 'the PDF must carry the DRAFT watermark');
  assert.ok(squeezeIncludes(pdfText, DRAFT_TEXT), 'the PDF must carry the Thai DRAFT text');
  assert.ok(squeezeIncludes(pdfText, 'ข้อมูลยังไม่ครบถ้วน'), 'the PDF must name the partial status in Thai');
  assert.ok(pdfPageCount(pdf.buffer) >= 1);
});

test('a pending-policy month is watermarked and claims no expected days', async () => {
  const repositories = createFixtureRepositories();
  await populatePendingPolicyMonth(repositories, 2027, 3);
  const service = exportService(repositories);
  const xlsx = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2027, month: 3, format: 'xlsx',
  });
  assert.equal(xlsx.report.report.computationStatus, 'pending_policy');
  assert.equal(xlsx.report.report.isFinal, false);

  const values = summaryValues(readWorkbook(xlsx.buffer).sheets['สรุป']);
  assert.equal(values['วันทำงานที่คาดหมาย'], 'ไม่สามารถคำนวณได้', 'NULL must never be exported as 0');
  assert.ok(artifactText(xlsx.buffer).includes(DRAFT_TEXT));
});

test('a calculated month carries no DRAFT watermark', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const service = exportService(repositories);
  for (const format of ['xlsx', 'pdf']) {
    const artifact = await service.exportReport(ADMIN_AUTH, {
      kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format,
    });
    assert.equal(artifact.report.report.isFinal, true);
    if (format === 'xlsx') {
      assert.equal(artifactText(artifact.buffer).includes('DRAFT'), false);
    } else {
      assert.equal(extractPdfText(artifact.buffer).includes('DRAFT'), false);
    }
  }
});

test('a not_derived month exports with no fabricated totals and is watermarked', async () => {
  const repositories = createFixtureRepositories();
  const service = exportService(repositories);
  const artifact = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 7, format: 'xlsx',
  });

  assert.equal(artifact.report.month, null, 'there is no month body to mistake for a month of zeros');
  assert.deepEqual(artifact.report.days, []);
  const { sheets, names } = readWorkbook(artifact.buffer);
  const values = summaryValues(sheets['สรุป']);
  for (const [, label] of TOTALS_LABELS) {
    assert.equal(label in values, false, `${label} must not be published for a month that was never derived`);
  }
  assert.ok(sheets['สรุป'].some((row) => (
    typeof row.cells[1] === 'string' && row.cells[1].includes('ไม่ใช่ยอดรวมศูนย์')
  )), 'the artifact must say the totals are absent rather than show zeros');
  assert.deepEqual(names, ['สรุป'], 'no empty day table for a month with no days');
  assert.ok(artifactText(artifact.buffer).includes(DRAFT_TEXT));
});

// --- 3. authorization -------------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function raw(port, path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

async function login(port, email) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'valid-pass' }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}

const crossPaths = (uid) => [
  `/api/v1/attendance/export/day/${uid}/2026-03-02?format=xlsx`,
  `/api/v1/attendance/export/month/${uid}/2026/3?format=xlsx`,
  `/api/v1/attendance/export/academic-year/${uid}/2026?format=xlsx`,
];

test('exports require a token, and a cross-scope caller gets a JSON 403, never a file', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    for (const path of crossPaths(USER_UID)) {
      const anonymous = await raw(port, path);
      assert.equal(anonymous.status, 401, `${path} must require a token`);
      assert.match(anonymous.headers.get('content-type'), /application\/json/);
      assert.equal(anonymous.buffer.includes('%PDF'), false, 'an anonymous request must never receive a file');
    }

    const token = await login(port, 'user@example.test');
    for (const path of crossPaths(ADMIN_UID)) {
      const cross = await raw(port, path, token);
      assert.equal(cross.status, 403, path);
      assert.match(cross.headers.get('content-type'), /application\/json/);
      assert.equal(cross.headers.get('content-disposition'), null);
      const body = JSON.parse(cross.buffer.toString('utf8'));
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'FORBIDDEN');
      assert.equal(cross.buffer.includes(0x25), false, 'a 403 must not be a PDF');
      assert.equal(cross.buffer.includes(0x50) && cross.buffer.includes(0x4B), false, 'a 403 must not be a ZIP');
    }
  } finally {
    server.close();
  }
});

test('an unknown employee outside the caller scope is still a 403, not an existence oracle', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const token = await login(port, 'user@example.test');
    const response = await raw(port, '/api/v1/attendance/export/month/ffffffff-ffff-ffff-ffff-ffffffffffff/2026/3?format=xlsx', token);
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.buffer.toString('utf8')).error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

// --- 4. parameter validation -------------------------------------------------------------------

test('bad parameters are 400 with the right code and never a file', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  const base = `/api/v1/attendance/export/month/${USER_UID}/2026/3`;
  const cases = [
    [`${base}`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=csv`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=../../etc/passwd`, 'EXPORT_INVALID_FORMAT'],
    [`/api/v1/attendance/export/month/${USER_UID}/2026/13?format=xlsx`, 'REPORT_INVALID_PERIOD'],
    [`/api/v1/attendance/export/month/${USER_UID}/1999/3?format=xlsx`, 'REPORT_INVALID_PERIOD'],
    [`/api/v1/attendance/export/day/${USER_UID}/2026-02-31?format=xlsx`, 'REPORT_INVALID_DATE'],
    [`/api/v1/attendance/export/day/${USER_UID}/nonsense?format=xlsx`, 'REPORT_INVALID_DATE'],
  ];
  // A rejected date carries whichever code the R-02 date parser raises; the export must not invent one.
  const dateCodes = ['REPORT_INVALID_DATE', 'IDENTIFIER_INVALID_EFFECTIVE_DATE'];
  try {
    const token = await login(port, 'user@example.test');
    for (const [path, code] of cases) {
      const response = await raw(port, path, token);
      assert.equal(response.status, 400, `${path} must be rejected`);
      assert.match(response.headers.get('content-type'), /application\/json/, path);
      assert.equal(response.headers.get('content-disposition'), null, path);
      const observed = JSON.parse(response.buffer.toString('utf8')).error.code;
      if (code === 'REPORT_INVALID_DATE') {
        assert.ok(dateCodes.includes(observed), `${path} produced ${observed}`);
      } else {
        assert.equal(observed, code, path);
      }
    }
    // A rejected FORMAT never reaches a renderer at all.
    const rejected = await raw(port, `${base}?format=csv`, token);
    assert.ok(rejected.buffer.length < 400, 'a 400 is a small JSON envelope, not a document');
  } finally {
    server.close();
  }
});

test('kind is validated by the service', async () => {
  const service = exportService(createFixtureRepositories());
  await assert.rejects(
    () => service.exportReport(ADMIN_AUTH, { kind: 'week', employeeUid: USER_UID, year: 2026, format: 'pdf' }),
    (error) => error.status === 400 && error.code === 'EXPORT_INVALID_KIND',
  );
  await assert.rejects(
    () => service.exportReport(ADMIN_AUTH, { kind: 'day', employeeUid: USER_UID, date: '2026-03-02' }),
    (error) => error.status === 400 && error.code === 'EXPORT_INVALID_FORMAT',
  );
  // A format is accepted case-insensitively, but the extension stays canonical.
  const upper = await service.exportReport(ADMIN_AUTH, {
    kind: 'day', employeeUid: USER_UID, date: '2026-03-02', format: 'PDF',
  });
  assert.match(upper.fileName, /\.pdf$/);
});

// --- 5. filename safety ------------------------------------------------------------------------

test('the export filename is ASCII-only whatever the uid looks like', () => {
  const hostile = [
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '"quoted"',
    'a b c',
    'ผู้ใช้/ทดสอบ',
    '\u0000\u0007',
    '../../..',
    '',
    null,
  ];
  for (const uid of hostile) {
    const name = safeExportFileName({ kind: 'month', period: '2026-03', employeeUid: uid, format: 'xlsx' });
    assert.match(name, /^[A-Za-z0-9._-]+$/, `${JSON.stringify(uid)} produced ${name}`);
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('\\'), false);
    assert.equal(name.includes('..'), false);
    assert.ok(name.length <= 120);
    assert.match(name, /^attendance-report-month-2026-03-[A-Za-z0-9]{1,8}\.xlsx$/);
  }
});

test('a hostile uid path segment produces a header-safe filename and never a path', async () => {
  const repositories = createFixtureRepositories();
  // Widen the scope and answer the existence check so the hostile uid reaches the filename builder.
  repositories.authorization.grantsFor = async (uid) => [
    { employeeUid: uid, scopeType: 'organization', role: 'EXECUTIVE' },
  ];
  repositories.employees.findByUid = async (uid) => ({
    employeeUid: uid,
    employeeId: 'E-HOSTILE',
    firstNameTh: 'ทดสอบ',
    lastNameTh: 'ระบบ',
    department: 'ไอที',
    position: 'นักพัฒนา',
  });
  const auth = { employeeUid: ADMIN_UID, role: 'executive' };
  const service = exportService(repositories);

  for (const uid of ['..%2f..%2fetc%2fpasswd', '../../etc/passwd', '"a b"', 'ผู้ใช้ทดสอบ']) {
    const artifact = await service.exportReport(auth, {
      kind: 'day', employeeUid: uid, date: '2026-03-02', format: 'pdf',
    });
    assert.match(artifact.fileName, /^[A-Za-z0-9._-]+$/);
    assert.equal(artifact.fileName.includes('/'), false);
    assert.equal(artifact.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  }
});

// --- 6. headers --------------------------------------------------------------------------------

test('the export response is a cache-safe binary download with the real length', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const token = await login(port, 'user@example.test');
    const xlsx = await raw(port, `/api/v1/attendance/export/month/${USER_UID}/2026/3?format=xlsx`, token);
    assert.equal(xlsx.status, 200);
    assert.equal(
      xlsx.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(
      xlsx.headers.get('content-disposition'),
      `attachment; filename="attendance-report-month-2026-03-${USER_UID.replace(/-/g, '').slice(0, 8)}.xlsx"`,
    );
    assert.equal(Number(xlsx.headers.get('content-length')), xlsx.buffer.length);
    assert.equal(xlsx.headers.get('cache-control'), 'no-store, private');
    assert.equal(xlsx.headers.get('pragma'), 'no-cache');
    assert.equal(xlsx.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(xlsx.buffer.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');

    const pdf = await raw(port, `/api/v1/attendance/export/day/${USER_UID}/2026-03-02?format=pdf`, token);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Number(pdf.headers.get('content-length')), pdf.buffer.length);
    assert.equal(pdf.headers.get('cache-control'), 'no-store, private');
    assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  } finally {
    server.close();
  }
});

// --- 7. dates and timezone ---------------------------------------------------------------------

test('month boundaries, leap February and the BE year are rendered in Thai', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const service = exportService(repositories);

  const march = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'xlsx',
  });
  assert.deepEqual(march.report.report.period, {
    from: '2026-03-01', to: '2026-03-31', year: 2026, month: 3, key: '2026-03',
  });
  const marchValues = summaryValues(readWorkbook(march.buffer).sheets['สรุป']);
  assert.equal(marchValues['วันที่ตัดข้อมูล (dateCutoff)'], '6 มีนาคม 2569');

  // An academic year runs 1 June - 31 May, which the export must state in Buddhist Era.
  const year = await service.exportReport(ADMIN_AUTH, {
    kind: 'academic_year', employeeUid: USER_UID, year: 2026, format: 'xlsx',
  });
  const yearValues = summaryValues(readWorkbook(year.buffer).sheets['สรุป']);
  assert.equal(yearValues['ช่วงเวลาของปีการศึกษา'], '1 มิถุนายน 2569 - 31 พฤษภาคม 2570');

  // 2028 is a leap year: the February window must end on the 29th, in Thai.
  const leap = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2028, month: 2, format: 'xlsx',
  });
  assert.deepEqual(leap.report.report.period, {
    from: '2028-02-01', to: '2028-02-29', year: 2028, month: 2, key: '2028-02',
  });
  const leapPdf = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2028, month: 2, format: 'pdf',
  });
  const leapText = extractPdfText(leapPdf.buffer);
  assert.ok(squeezeIncludes(leapText, '1 กุมภาพันธ์ 2571'), 'the leap February window must open on the 1st');
  assert.ok(squeezeIncludes(leapText, '29 กุมภาพันธ์ 2571'), 'a leap February must end on the 29th, in BE');
});

test('Asian/Bangkok wall time is used for the generated-at line', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const artifact = await exportService(repositories).exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'xlsx',
  });
  // 2026-10-16T04:16:45Z is 11:16 on 16 October 2026 in Bangkok, displayed as BE 2569.
  const values = summaryValues(readWorkbook(artifact.buffer).sheets['สรุป']);
  assert.equal(values['สร้างเอกสารเมื่อ'], '16 ตุลาคม 2569 11:16');
});

// --- 8. Thai text and the Gregorian filename ---------------------------------------------------

test('Thai labels and the BE year travel in the body while the filename stays Gregorian', async () => {
  const repositories = createFixtureRepositories();
  await populatePartialMonth(repositories);
  const service = exportService(repositories);
  const xlsx = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'xlsx',
  });
  const pdf = await service.exportReport(ADMIN_AUTH, {
    kind: 'month', employeeUid: USER_UID, year: 2026, month: 3, format: 'pdf',
  });

  const xlsxXml = artifactText(xlsx.buffer);
  const pdfText = extractPdfText(pdf.buffer);
  for (const needle of [DRAFT_TEXT, 'ข้อมูลยังไม่ครบถ้วน', '2569']) {
    assert.ok(xlsxXml.includes(needle), `XLSX must contain ${needle}`);
    assert.ok(squeezeIncludes(pdfText, needle), `PDF must contain ${needle}`);
  }
  const statusLabel = summaryValues(readWorkbook(xlsx.buffer).sheets['สรุป'])['สถานะการคำนวณ (computationStatus)'];
  assert.equal(statusLabel, 'ข้อมูลยังไม่ครบถ้วน (partial)');
  assert.ok(squeezeIncludes(pdfText, 'มีนาคม'), 'the Thai month name must be in the PDF');
  assert.equal(xlsx.fileName, `attendance-report-month-2026-03-${USER_UID.slice(0, 8)}.xlsx`);
  assert.equal(xlsx.fileName.includes('2569'), false, 'the filename must never carry a Buddhist year');
  assert.equal(pdf.fileName.includes('2569'), false);
  assert.ok(squeezeIncludes(pdfText, '2569'), 'the body, unlike the filename, shows the Buddhist year');
});

// --- 9. formula injection ----------------------------------------------------------------------

test('a stored note that looks like a formula is exported as literal text', async () => {
  const repositories = createFixtureRepositories();
  await repositories.dailyAttendance.upsertDay(dayRow({
    date: '2026-03-02',
    status: 'present',
    computationStatus: 'calculated',
    checkIn: '2026-03-02 08:30:00',
    checkOut: '2026-03-02 16:30:00',
    workDuration: 480,
    notes: '=2+3 & <probe> "quoted"',
    reconciliationJson: null,
  }));
  const artifact = await exportService(repositories).exportReport(ADMIN_AUTH, {
    kind: 'day', employeeUid: USER_UID, date: '2026-03-02', format: 'xlsx',
  });

  const text = artifactText(artifact.buffer);
  assert.equal(text.includes('<f>'), false, 'no cell may be written as a formula');
  assert.equal(text.includes('<f '), false);
  assert.ok(
    text.includes('=2+3 &amp; &lt;probe&gt; &quot;quoted&quot;'),
    'the note must be an escaped inline string',
  );

  const values = summaryValues(readWorkbook(artifact.buffer).sheets['สรุป']);
  assert.equal(values['หมายเหตุ'], '=2+3 & <probe> "quoted"');
});
