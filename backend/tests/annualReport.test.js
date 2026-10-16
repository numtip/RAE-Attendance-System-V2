/**
 * R-05 annual HR report — domain, service, artifact and API level (fixture repositories, no database).
 *
 * The suite is built around the four things an annual HR report must get right:
 *
 *   1. the annual total IS the sum of the monthly R-02 values (proved against R-02's own output, never
 *      against numbers typed a second time);
 *   2. a year whose months are not all derived AND judged has NO annual total — `null` with a reason,
 *      never `0` and never a partial sum presented as the annual figure;
 *   3. a year that is not final renders through the R-03 renderer with the SAME DRAFT watermark, in both
 *      formats;
 *   4. the fiscal year (Oct-Sep) and the academic year (Jun-May) are different windows and the payload
 *      never confuses them.
 *
 * The artifacts are read back INDEPENDENTLY of the code that wrote them: the XLSX is unzipped with
 * `node:zlib` and its sheet XML parsed here, and the PDF text layer is decoded from the embedded
 * `ToUnicode` CMaps. Nothing here trusts `xlsxWriter`/`pdfRenderer` to describe itself.
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

require('./helpers/syntheticIdentifierKeys');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createAttendanceReportService } = require('../src/services/attendanceReportService');
const { createAnnualReportService } = require('../src/services/annualReportService');
const { TOTALS_LABELS } = require('../src/domain/attendanceReportPresentation');
const {
  ANNUAL_TOTAL_FIELDS,
  ANNUAL_NULLABLE_FIELD,
  ANNUAL_TOTAL_REASON,
  MONTH_EXCLUSION,
  annualPeriodOf,
  monthExclusionReason,
  buildAnnualTotals,
  buildMonthCoverage,
  annualVerdictOf,
  annualComputationStatusOf,
} = require('../src/domain/annualAttendanceReport');
const { createApp } = require('../src/app');
const {
  USER_UID,
  ADMIN_UID,
  CLOSED_FISCAL_YEAR,
  FIXED_NOW,
  monthValues,
  seedCompleteFiscalYear,
  seedFiscalYearMissingMonth,
  seedFiscalYearUnjudgedMonth,
  seedSplitOwnershipYear,
  stubAssignmentHistory,
} = require('./fixtures/annualSyntheticFacts');

const SELF_AUTH = { employeeUid: USER_UID, role: 'user' };
const DRAFT_TEXT = 'ข้อมูลยังไม่สมบูรณ์';
const ALL_TOTAL_FIELDS = [...ANNUAL_TOTAL_FIELDS, ANNUAL_NULLABLE_FIELD];

function annualService(repositories) {
  return createAnnualReportService({ repositories, now: FIXED_NOW });
}

function r02Service(repositories) {
  return createAttendanceReportService({ repositories, now: FIXED_NOW });
}

// --- artifact readers, sharing no code with the writer ------------------------------------------

function zipEntries(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    offset = dataStart + compressedSize;
  }
  return entries;
}

/** Every part of the package decoded, so a Thai string can be found (the parts are compressed). */
function workbookText(buffer) {
  return Object.values(zipEntries(buffer)).map((entry) => entry.toString('utf8')).join('\n');
}

function columnIndex(letters) {
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

function unescapeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseSheetRows(xml) {
  const byRow = new Map();
  for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const column = columnIndex(match[1]);
    const row = Number(match[2]);
    const inner = match[4];
    let value;
    if (match[3].includes('t="inlineStr"')) {
      const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      value = text ? unescapeXml(text[1]) : '';
    } else {
      const number = /<v>([\s\S]*?)<\/v>/.exec(inner);
      value = number ? Number(number[1]) : null;
    }
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row)[column] = value;
  }
  return [...byRow.keys()].sort((a, b) => a - b).map((row) => byRow.get(row));
}

/** The two-column summary sheet ('สรุป', part 1) as label -> value. */
function summaryValues(buffer) {
  const entries = zipEntries(buffer);
  const xml = entries['xl/worksheets/sheet1.xml'].toString('utf8');
  const values = {};
  for (const cells of parseSheetRows(xml)) {
    if (cells.length < 2 || cells[0] == null || cells[1] == null) continue;
    values[String(cells[0])] = cells[1];
  }
  return values;
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
 * The PDF text layer, decoded from the content streams via each font's ToUnicode CMap. A Thai word
 * containing U+0E33 SARA AM extracts decomposed (a documented pdfkit limitation), so assertions use
 * needles without it plus whitespace-insensitive containment.
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

const squeeze = (text) => text.replace(/\s+/g, '');

// --- 1. the domain contract --------------------------------------------------------------------

test('the fiscal and academic annual windows differ and every period names its convention', () => {
  const fiscal = annualPeriodOf('fiscal', 2569);
  assert.equal(fiscal.periodKind, 'fiscal');
  assert.equal(fiscal.reportKind, 'annual_fiscal');
  assert.equal(fiscal.from, '2025-10-01');
  assert.equal(fiscal.to, '2026-09-30');
  assert.equal(fiscal.startMonth, 10);
  assert.equal(fiscal.labelTh, 'ปีงบประมาณ 2569');
  assert.equal(fiscal.months.length, 12);
  assert.deepEqual(fiscal.months[0], { year: 2025, month: 10 }, 'October of the start year');
  assert.deepEqual(fiscal.months[11], { year: 2026, month: 9 }, 'then September of the next year');

  const academic = annualPeriodOf('academic', 2026);
  assert.equal(academic.periodKind, 'academic');
  assert.equal(academic.reportKind, 'annual_academic');
  assert.equal(academic.from, '2026-06-01');
  assert.equal(academic.to, '2027-05-31');
  assert.equal(academic.startMonth, 6);
  assert.equal(academic.labelTh, 'ปีการศึกษา 2569');
  assert.equal(academic.months.length, 12);
  assert.deepEqual(academic.months[0], { year: 2026, month: 6 }, 'June of the start year');
  assert.deepEqual(academic.months[11], { year: 2027, month: 5 }, 'then May of the next year');

  // The two windows must DIFFER, so a fiscal request can never be answered with an academic window.
  assert.notEqual(fiscal.from, academic.from);
  assert.notEqual(fiscal.to, academic.to);
  assert.notDeepEqual(fiscal.months, academic.months);
  assert.notEqual(fiscal.startMonth, academic.startMonth);

  // A caller must NAME the convention, and an unknown one is refused rather than defaulted.
  assert.throws(
    () => annualPeriodOf('nope', 2569),
    (error) => error.status === 400 && error.code === 'ANNUAL_INVALID_PERIOD_KIND',
  );
  assert.throws(() => annualPeriodOf('fiscal', 'nonsense'), (error) => error.status === 400);
  assert.throws(() => annualPeriodOf('fiscal', 1999), (error) => error.status === 400);
  assert.throws(() => annualPeriodOf('academic', 1999), (error) => error.status === 400);
});

test('the annual verdict is worst-of, and a year with nothing to judge is never complete', () => {
  const judged = { started: true, isFinal: true, computationStatus: 'calculated' };
  const partial = { started: true, isFinal: false, computationStatus: 'partial' };
  const future = { started: false, isFinal: false, computationStatus: 'not_derived' };

  assert.equal(annualVerdictOf({ months: [judged, judged], periodClosed: true }), 'complete');
  assert.equal(annualVerdictOf({ months: [judged, partial], periodClosed: true }), 'incomplete');
  assert.equal(annualVerdictOf({ months: [judged], periodClosed: false }), 'incomplete', 'an open year is not concluded');
  assert.equal(
    annualVerdictOf({ months: [future, future], periodClosed: true }),
    'incomplete',
    'nothing started is never complete',
  );
  assert.equal(annualVerdictOf({ months: [], periodClosed: true }), 'incomplete');
  assert.equal(annualVerdictOf({}), 'incomplete');

  assert.equal(annualComputationStatusOf([judged, partial]), 'partial');
  assert.equal(annualComputationStatusOf([judged, { computationStatus: 'not_derived' }]), 'not_derived');
  assert.equal(annualComputationStatusOf([]), 'not_derived');
});

test('a month is excluded for a named reason, and only a fully contributing year gets a total', () => {
  const month = (index, extra = {}) => ({
    key: `2025-${String(index + 1).padStart(2, '0')}`,
    started: true,
    reportAvailable: true,
    isFinal: true,
    computationStatus: 'calculated',
    totals: { ...monthValues(index), ...extra },
  });

  assert.equal(monthExclusionReason(month(0)), null);
  assert.equal(monthExclusionReason({ started: false }), MONTH_EXCLUSION.NOT_YET_STARTED);
  assert.equal(monthExclusionReason({ started: true, reportAvailable: false }), MONTH_EXCLUSION.NEVER_DERIVED);
  assert.equal(
    monthExclusionReason({ started: true, reportAvailable: true, isFinal: false, computationStatus: 'pending_policy' }),
    'month_pending_policy',
  );

  const complete = buildAnnualTotals([month(0), month(1)]);
  assert.equal(complete.totals.totalPresent, (10 + 0) + (10 + 1));
  assert.equal(complete.totals.expectedWorkingDays, (20 + 0) + (20 + 1));
  assert.deepEqual(buildMonthCoverage([month(0), month(1)]).monthsExcluded, []);
  assert.equal(buildMonthCoverage([month(0), month(1)]).complete, true);
  assert.equal(buildMonthCoverage([]).complete, false, 'an empty period is never complete');

  const incomplete = buildAnnualTotals([month(0), { key: '2025-02', started: true, reportAvailable: false }]);
  assert.equal(incomplete.totals.totalPresent, null);
  assert.notEqual(incomplete.totals.totalPresent, 0);
  assert.equal(incomplete.availability.totalPresent.reason, ANNUAL_TOTAL_REASON.INCOMPLETE_COVERAGE);
  assert.equal(incomplete.availability.expectedWorkingDays.available, false);

  // Every month contributes, but one cannot derive `expectedWorkingDays`: only THAT metric is null.
  const valueBlocked = buildAnnualTotals([month(0), month(1, { expectedWorkingDays: null })]);
  assert.equal(valueBlocked.totals.totalPresent, (10 + 0) + (10 + 1));
  assert.equal(valueBlocked.totals.expectedWorkingDays, null, 'a summed NULL would read as zero');
  assert.equal(valueBlocked.availability.expectedWorkingDays.reason, ANNUAL_TOTAL_REASON.VALUE_UNAVAILABLE);
});

// --- 2. the annual total IS the sum of the monthly R-02 values ---------------------------------

test('a complete judged fiscal year sums exactly the monthly R-02 values', async () => {
  const repositories = createFixtureRepositories();
  const { seeded } = await seedCompleteFiscalYear(repositories);
  const payload = await annualService(repositories).fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);

  // The expectation is built from R-02's OWN month reports, never from numbers typed a second time.
  const expected = {};
  const r02 = r02Service(repositories);
  for (const entry of seeded) {
    const month = await r02.monthReport(SELF_AUTH, USER_UID, entry.year, entry.month);
    assert.equal(month.report.isFinal, true, `${entry.key} must be judged for this test to mean anything`);
    for (const field of ALL_TOTAL_FIELDS) {
      expected[field] = (expected[field] ?? 0) + Number(month.month[field]);
    }
  }

  for (const field of ALL_TOTAL_FIELDS) {
    assert.equal(payload.totals[field], expected[field], `${field} must equal the sum of the R-02 months`);
    assert.equal(payload.totalsAvailability[field].available, true, `${field} must be available`);
    assert.equal(payload.totalsAvailability[field].reason, null);
  }

  // Non-vacuous: the annual figure is larger than ANY single month, so it really summed twelve months.
  for (const entry of seeded) {
    assert.ok(
      payload.totals.totalPresent > entry.values.totalPresent,
      `the annual total must exceed ${entry.key}'s own value`,
    );
  }

  assert.equal(payload.monthCoverage.complete, true);
  assert.deepEqual(payload.monthCoverage.monthsExcluded, []);
  assert.equal(payload.monthCoverage.monthsContributed.length, 12);
  assert.equal(payload.report.isFinal, true);
  assert.equal(payload.report.annualVerdict, 'complete');
  assert.equal(payload.report.computationStatus, 'calculated');
  assert.deepEqual(payload.report.statusReasons, [], 'a complete year explains no gap');
  assert.equal(payload.report.period.periodKind, 'fiscal');
  assert.equal(payload.report.period.from, '2024-10-01');
  assert.equal(payload.report.period.to, '2025-09-30');
  assert.equal(payload.report.period.labelTh, 'ปีงบประมาณ 2568');
  assert.equal(payload.report.population.employees, 1);
  assert.equal(payload.report.population.employeeUid, USER_UID);
  assert.equal(payload.months.length, 12);
  for (const entry of payload.months) {
    assert.equal(typeof entry.computationStatus, 'string');
    assert.equal(typeof entry.isFinal, 'boolean');
    assert.ok(Array.isArray(entry.ruleVersions));
    assert.ok(Array.isArray(entry.caveats));
    assert.equal(typeof entry.population.dayRows, 'number');
  }

  // R-02's limitations must travel into the annual report, not be dropped on the way up: the synthetic
  // months have a derived expectedWorkingDays and the holiday calendar is empty, so R-02 raises this.
  assert.ok(
    payload.report.caveats.map((caveat) => caveat.code).includes('HOLIDAY_CALENDAR_EMPTY'),
    'the month caveats must be unioned into the annual report',
  );
  assert.ok(payload.report.caveats.every((caveat) => typeof caveat.detail === 'string'));
  assert.deepEqual(payload.report.ruleVersions, ['AR-SYNTHETIC'], 'the rule that produced the months is named');
  assert.deepEqual(payload.report.population, { employees: 1, employeeUid: USER_UID, dayRows: 0 });
});

// --- 3. the null discipline, end to end -------------------------------------------------------

test('a never-derived month yields a NULL annual total, never 0 and never a partial sum', async () => {
  const repositories = createFixtureRepositories();
  const { seeded, missing } = await seedFiscalYearMissingMonth(repositories, { missingMonth: 4 });
  const payload = await annualService(repositories).fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);

  const partialSum = seeded.reduce((sum, entry) => sum + entry.values.totalPresent, 0);
  assert.equal(payload.totals.totalPresent, null);
  assert.notEqual(payload.totals.totalPresent, 0, 'a missing month must never be read as zero');
  assert.notEqual(payload.totals.totalPresent, partialSum, 'a partial sum is not the annual figure');
  assert.equal(payload.totals.expectedWorkingDays, null);
  assert.equal(payload.totalsAvailability.totalPresent.available, false);
  assert.equal(payload.totalsAvailability.totalPresent.reason, 'annual_total_requires_a_complete_year');
  assert.equal(
    payload.totalsAvailability.expectedWorkingDays.reason,
    'annual_total_requires_a_complete_year',
  );

  assert.equal(payload.monthCoverage.complete, false);
  assert.deepEqual(payload.monthCoverage.monthsExcluded, [{ key: missing.key, reason: 'month_not_derived' }]);
  assert.ok(payload.report.statusReasons.includes(`month_not_derived:${missing.key}`));
  assert.equal(payload.report.isFinal, false);
  assert.equal(payload.report.annualVerdict, 'incomplete');
  assert.equal(payload.report.computationStatus, 'not_derived', 'the worst month decides');
});

test('a year whose months have not started is incomplete and publishes no total', async () => {
  const repositories = createFixtureRepositories();
  // FY2570 = 2026-10-01 .. 2027-09-30 is open on the injected 2026-10-16 clock; most months are future.
  const payload = await annualService(repositories).fiscalYearReport(SELF_AUTH, USER_UID, 2570);

  assert.equal(payload.report.isFinal, false);
  assert.equal(payload.report.annualVerdict, 'incomplete');
  assert.equal(payload.totals.totalPresent, null);
  assert.equal(payload.monthCoverage.complete, false);
  assert.ok(payload.monthCoverage.monthsExcluded.length > 0);
  assert.ok(payload.monthCoverage.reasonCodes.includes('month_not_yet_started'));
  assert.ok(payload.report.statusReasons.includes('annual_period_not_closed'));
});

test('an unjudged month keeps the year non-final and watermarks the artifact in both formats', async () => {
  const repositories = createFixtureRepositories();
  const { seeded } = await seedFiscalYearUnjudgedMonth(repositories, { unjudgedMonth: 12, status: 'partial' });
  const service = annualService(repositories);
  const unjudgedKey = seeded.find((entry) => entry.computationStatus === 'partial').key;

  const payload = await service.fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  assert.equal(payload.report.isFinal, false);
  assert.equal(payload.report.annualVerdict, 'incomplete');
  assert.equal(payload.report.computationStatus, 'partial');
  assert.ok(payload.report.statusReasons.includes(`month_partial:${unjudgedKey}`));
  assert.equal(payload.totals.totalPresent, null);
  assert.deepEqual(payload.monthCoverage.monthsExcluded, [{ key: unjudgedKey, reason: 'month_partial' }]);

  const xlsx = await service.exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'xlsx',
  });
  assert.equal(xlsx.report.report.isFinal, false);
  const xml = workbookText(xlsx.buffer);
  assert.ok(xml.includes('DRAFT — ข้อมูลยังไม่สมบูรณ์'), 'the XLSX must carry the R-03 DRAFT banner row');

  const pdf = await service.exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'pdf',
  });
  const text = extractPdfText(pdf.buffer);
  assert.ok(text.includes('DRAFT'), 'the PDF must carry the R-03 DRAFT watermark');
  assert.ok(squeeze(text).includes(DRAFT_TEXT), 'the PDF must carry the Thai DRAFT text');
});

test('a complete judged year carries no DRAFT watermark in either format', async () => {
  const repositories = createFixtureRepositories();
  await seedCompleteFiscalYear(repositories);
  const service = annualService(repositories);
  for (const format of ['xlsx', 'pdf']) {
    const artifact = await service.exportAnnualReport(SELF_AUTH, {
      periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format,
    });
    assert.equal(artifact.report.report.isFinal, true, `${format} must be final for this test to mean anything`);
    if (format === 'xlsx') {
      assert.equal(workbookText(artifact.buffer).includes('DRAFT'), false);
    } else {
      assert.equal(extractPdfText(artifact.buffer).includes('DRAFT'), false);
      assert.ok(artifact.buffer.toString('latin1').includes('final attendance report'));
    }
  }
});

// --- 4. the exported values ARE the R-02-derived annual values ---------------------------------

test('the artifact numbers equal the annual total, and an absent total is the Thai sentence', async () => {
  const repositories = createFixtureRepositories();
  await seedFiscalYearMissingMonth(repositories, { missingMonth: 4 });
  const payload = await annualService(repositories).fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  assert.equal(payload.totals.totalPresent, null, 'the fixture must leave one month out');

  const artifact = await annualService(repositories).exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'xlsx',
  });
  const values = summaryValues(artifact.buffer);
  for (const [, label] of TOTALS_LABELS) {
    assert.equal(values[label], 'ไม่สามารถคำนวณได้', `${label} must be published as the Thai sentence, never 0`);
  }
  // The months sheet still lists what WAS available, so a reader can see the gap.
  const monthsXml = zipEntries(artifact.buffer)['xl/worksheets/sheet2.xml'].toString('utf8');
  assert.ok(monthsXml.includes('มี'), 'the month table must still be present');
  assert.ok(monthsXml.includes('ไม่มี'), 'the month that was never derived must be marked absent');

  const complete = createFixtureRepositories();
  await seedCompleteFiscalYear(complete);
  const finalPayload = await annualService(complete).fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  const finalArtifact = await annualService(complete).exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'xlsx',
  });
  const finalValues = summaryValues(finalArtifact.buffer);
  for (const [field, label] of TOTALS_LABELS) {
    assert.equal(typeof finalValues[label], 'number', `${label} must be a NUMBER`);
    assert.equal(finalValues[label], finalPayload.totals[field], `${label} must equal the annual total`);
  }
  assert.equal(finalValues['ผลสรุปรายปี (annualVerdict)'], 'ครบถ้วน (complete)');
  assert.equal(finalValues['สรุปเป็นผลสรุปได้ (isFinal)'], 'ใช่ (true)');
  assert.equal(finalValues[TOTALS_LABELS[1][1]], finalPayload.totals.totalPresent);
});

// --- 5. fiscal vs academic over HTTP ------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function json(port, path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
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

test('a fiscal request returns the fiscal window, never an academic one; a bad year is 400', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const token = await login(port, 'user@example.test');

    const fiscal = await json(port, `/api/v1/attendance/report/fiscal-year/${USER_UID}/2568`, token);
    assert.equal(fiscal.status, 200);
    assert.equal(fiscal.body.success, true);
    assert.equal(fiscal.body.data.report.period.periodKind, 'fiscal');
    assert.equal(fiscal.body.data.report.period.from, '2024-10-01');
    assert.equal(fiscal.body.data.report.period.to, '2025-09-30');
    assert.equal(fiscal.body.data.report.period.startMonth, 10);
    assert.equal(fiscal.body.data.report.kind, 'annual_fiscal');
    assert.deepEqual(fiscal.body.data.report.period.months, [
      { year: 2024, month: 10 }, { year: 2024, month: 11 }, { year: 2024, month: 12 },
      { year: 2025, month: 1 }, { year: 2025, month: 2 }, { year: 2025, month: 3 },
      { year: 2025, month: 4 }, { year: 2025, month: 5 }, { year: 2025, month: 6 },
      { year: 2025, month: 7 }, { year: 2025, month: 8 }, { year: 2025, month: 9 },
    ], 'a fiscal response must list the Oct..Sep months, never the Jun..May ones');
    // The academic convention must not appear anywhere in a fiscal response.
    assert.equal(JSON.stringify(fiscal.body.data).includes('annual_academic'), false);
    assert.equal(fiscal.body.data.period.periodKind, 'fiscal');
    assert.equal(fiscal.body.data.yearSummary.periodKind, 'fiscal');

    const academic = await json(port, `/api/v1/attendance/report/annual-academic/${USER_UID}/2025`, token);
    assert.equal(academic.status, 200);
    assert.equal(academic.body.data.report.period.periodKind, 'academic');
    assert.equal(academic.body.data.report.period.from, '2025-06-01');
    assert.equal(academic.body.data.report.period.to, '2026-05-31');
    assert.equal(academic.body.data.report.period.startMonth, 6);
    assert.equal(academic.body.data.report.kind, 'annual_academic');
    assert.notDeepEqual(fiscal.body.data.report.period.months, academic.body.data.report.period.months);

    for (const bad of ['nonsense', '1900', '0']) {
      const rejected = await json(port, `/api/v1/attendance/report/fiscal-year/${USER_UID}/${bad}`, token);
      assert.equal(rejected.status, 400, `${bad} must be rejected`);
      assert.equal(rejected.body.success, false);
    }
  } finally {
    server.close();
  }
});

test('the annual endpoints require a token and refuse a cross-scope or unknown employee', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  const own = `/api/v1/attendance/report/fiscal-year/${USER_UID}/2568`;
  const cross = `/api/v1/attendance/report/fiscal-year/${ADMIN_UID}/2568`;
  const ownExport = `/api/v1/attendance/export/fiscal-year/${USER_UID}/2568?format=xlsx`;
  const crossExport = `/api/v1/attendance/export/fiscal-year/${ADMIN_UID}/2568?format=xlsx`;
  try {
    for (const path of [own, ownExport]) {
      const anonymous = await raw(port, path);
      assert.equal(anonymous.status, 401, `${path} must require a token`);
      assert.match(anonymous.headers.get('content-type'), /application\/json/);
      assert.equal(anonymous.headers.get('content-disposition'), null);
    }

    const token = await login(port, 'user@example.test');
    for (const path of [cross, crossExport]) {
      const refused = await raw(port, path, token);
      assert.equal(refused.status, 403, path);
      assert.match(refused.headers.get('content-type'), /application\/json/);
      assert.equal(refused.headers.get('content-disposition'), null);
      assert.equal(JSON.parse(refused.buffer.toString('utf8')).error.code, 'FORBIDDEN');
      assert.equal(refused.buffer.includes(0x25), false, 'a 403 must not be a PDF');
    }
  } finally {
    server.close();
  }
});

test('an unknown employee inside the caller scope is a 404, never a silent empty report', async () => {
  const repositories = createFixtureRepositories();
  repositories.authorization.grantsFor = async (uid) => [
    { employeeUid: uid, scopeType: 'organization', role: 'EXECUTIVE' },
  ];
  const executive = { employeeUid: ADMIN_UID, role: 'executive' };
  const service = annualService(repositories);

  await assert.rejects(
    () => service.fiscalYearReport(executive, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 2568),
    (error) => error.status === 404 && error.code === 'ANNUAL_UNKNOWN_EMPLOYEE',
  );
  // Scope is checked BEFORE existence: a cross-scope caller learns nothing about the id.
  await assert.rejects(
    () => service.fiscalYearReport(SELF_AUTH, ADMIN_UID, 2568),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
});

// --- 6. format validation ----------------------------------------------------------------------

test('format is required with no default, and a rejected format never returns a file', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  const base = `/api/v1/attendance/export/fiscal-year/${USER_UID}/2568`;
  const cases = [
    [`${base}`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=csv`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=../../etc/passwd`, 'EXPORT_INVALID_FORMAT'],
    [`${base}?format=pdf&format=xlsx`, 'EXPORT_INVALID_FORMAT'],
  ];
  try {
    const token = await login(port, 'user@example.test');
    for (const [path, code] of cases) {
      const response = await raw(port, path, token);
      assert.equal(response.status, 400, `${path} must be rejected`);
      assert.match(response.headers.get('content-type'), /application\/json/, path);
      assert.equal(response.headers.get('content-disposition'), null, path);
      assert.equal(JSON.parse(response.buffer.toString('utf8')).error.code, code, path);
      assert.ok(response.buffer.length < 400, 'a refusal is a small JSON envelope, never a document');
    }
    // A valid format still works, so the probe above is not just rejecting everything.
    const good = await raw(port, `${base}?format=xlsx`, token);
    assert.equal(good.status, 200);
    assert.equal(good.buffer.subarray(0, 2).toString('latin1'), 'PK');
  } finally {
    server.close();
  }
});

test('the export response is a cache-safe binary download with an ASCII Gregorian filename', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const token = await login(port, 'user@example.test');

    const xlsx = await raw(port, `/api/v1/attendance/export/fiscal-year/${USER_UID}/2568?format=xlsx`, token);
    assert.equal(xlsx.status, 200);
    assert.equal(
      xlsx.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(Number(xlsx.headers.get('content-length')), xlsx.buffer.length);
    assert.equal(xlsx.headers.get('cache-control'), 'no-store, private');
    assert.equal(xlsx.headers.get('pragma'), 'no-cache');
    assert.equal(xlsx.headers.get('x-content-type-options'), 'nosniff');
    const disposition = xlsx.headers.get('content-disposition');
    assert.match(disposition, /^attachment; filename="[A-Za-z0-9._-]+"$/);
    assert.equal(disposition.includes('2568'), false, 'the filename must never carry a Buddhist year');
    assert.ok(disposition.includes('2024-10-2025-09'), 'the filename names the Gregorian fiscal window');

    const pdf = await raw(port, `/api/v1/attendance/export/fiscal-year/${USER_UID}/2568?format=pdf`, token);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Number(pdf.headers.get('content-length')), pdf.buffer.length);
    assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(pdf.headers.get('content-disposition').includes('2568'), false);
  } finally {
    server.close();
  }
});

// --- 7. ownership: a code that changes hands is never merged ------------------------------------

test('two holders of one code are two employees and their months are never merged into one total', async () => {
  const repositories = createFixtureRepositories();
  const { first, second } = await seedSplitOwnershipYear(repositories, { splitAt: 5 });
  const service = annualService(repositories);

  const firstHolder = await service.fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  const secondHolder = await service.fiscalYearReport(
    { employeeUid: ADMIN_UID, role: 'user' }, ADMIN_UID, CLOSED_FISCAL_YEAR,
  );

  assert.equal(firstHolder.monthCoverage.monthsContributed.length, first.length);
  assert.equal(firstHolder.monthCoverage.monthsExcluded.length, second.length);
  assert.equal(secondHolder.monthCoverage.monthsContributed.length, second.length);
  assert.equal(secondHolder.monthCoverage.monthsExcluded.length, first.length);

  // The two sets of months are disjoint: nothing was folded into one person's year.
  const firstKeys = new Set(firstHolder.monthCoverage.monthsContributed);
  for (const key of secondHolder.monthCoverage.monthsContributed) {
    assert.equal(firstKeys.has(key), false, `${key} must not appear in both employees' years`);
  }

  // A split year has no complete coverage, so each holder gets a NULL total rather than a merged sum.
  assert.equal(firstHolder.totals.totalPresent, null);
  assert.equal(secondHolder.totals.totalPresent, null);
  const merged = [...first, ...second].reduce((sum, entry) => sum + entry.values.totalPresent, 0);
  assert.notEqual(firstHolder.totals.totalPresent, merged);
  assert.notEqual(secondHolder.totals.totalPresent, merged);
  assert.equal(firstHolder.report.isFinal, false);
  assert.equal(secondHolder.report.isFinal, false);
});

test('a code change WITHIN one employee is recorded, and that employee\'s own months still sum', async () => {
  const repositories = createFixtureRepositories();
  await seedCompleteFiscalYear(repositories);
  // A synthetic history: the same person's code moved from E-SYN-A to E-SYN-B in month 7.
  stubAssignmentHistory(repositories, USER_UID, [
    { employeeCode: 'E-SYN-A', effectiveFrom: '2024-01-01', effectiveTo: '2025-03-31' },
    { employeeCode: 'E-SYN-B', effectiveFrom: '2025-04-01', effectiveTo: null },
  ]);

  const payload = await annualService(repositories).fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  const ownership = payload.ownership;
  assert.equal(ownership.source, 'employee_assignment');
  assert.deepEqual(ownership.distinctCodesInPeriod, ['E-SYN-A', 'E-SYN-B']);
  assert.equal(ownership.codeChangedWithinPeriod, true);
  assert.deepEqual(ownership.codeChangedAtMonths, ['2025-04']);
  assert.equal(ownership.employeeCodeByMonth['2024-10'], 'E-SYN-A');
  assert.equal(ownership.employeeCodeByMonth['2025-09'], 'E-SYN-B');
  // The SAME person keeps ONE annual total: a code change is not an ownership change (E14).
  assert.equal(payload.monthCoverage.complete, true);
  assert.equal(typeof payload.totals.totalPresent, 'number');

  // The honest limitation: a change of HOLDER across employees cannot be established from this layer's reads.
  assert.equal(ownership.crossEmployeeOwnershipDetection.evaluated, false);
  assert.match(ownership.crossEmployeeOwnershipDetection.reason, /no repository method/);
});

// --- 8. no PII, with an explicitly non-vacuous guard -------------------------------------------

const PII_RULES = [
  { name: 'passwordHash', pattern: /passwordHash/i },
  { name: 'national_id', pattern: /national_?id/i },
  { name: 'thirteen-digit-id', pattern: /\b\d{13}\b/ },
  { name: 'bearer-token', pattern: /Bearer\s/ },
  { name: 'jwt-shaped', pattern: /eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'hmac', pattern: /hmac/i },
];

/** Returns the names of the rules that matched. Exported nowhere: the guard is asserted here. */
function scanForPii(text) {
  return PII_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}

test('no annual response carries a national id, a password hash or a token', async () => {
  const repositories = createFixtureRepositories();
  await seedCompleteFiscalYear(repositories);
  const service = annualService(repositories);

  const payload = await service.fiscalYearReport(SELF_AUTH, USER_UID, CLOSED_FISCAL_YEAR);
  const artifact = await service.exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'pdf',
  });
  const serialized = JSON.stringify({ json: payload, artifact: artifact.report });

  // COVERAGE, asserted explicitly: an empty scan would prove nothing (the repo has been bitten twice by
  // a guard that read 0 files or matched 0 literals).
  assert.ok(serialized.length > 500, 'the scan must have a non-trivial payload to read');
  assert.ok(serialized.includes('computationStatus'), 'the scan must have read the real report body');
  assert.ok(serialized.includes(USER_UID), 'the scan must have read the population block');

  // POSITIVE CONTROL: the same scanner must catch a planted value, so it is not vacuous.
  assert.deepEqual(scanForPii('{"nationalId":"9900000000001"}'), ['national_id', 'thirteen-digit-id']);
  assert.deepEqual(scanForPii('{"passwordHash":"x"}'), ['passwordHash']);

  assert.deepEqual(scanForPii(serialized), [], 'the annual payload must contain no PII');

  const employee = await service.exportAnnualReport(SELF_AUTH, {
    periodKind: 'fiscal', employeeUid: USER_UID, year: CLOSED_FISCAL_YEAR, format: 'xlsx',
  });
  assert.equal(scanForPii(workbookText(employee.buffer)).includes('thirteen-digit-id'), false);
  assert.equal(JSON.stringify(employee.report).includes('passwordHash'), false);
});

// --- 9. the fixture itself must be synthetic and month-distinct --------------------------------

test('the synthetic fixture is month-distinct, so a copied value could never pass the sum assertions', () => {
  const values = [0, 1, 2].map(monthValues);
  assert.notDeepEqual(values[0], values[1]);
  assert.notDeepEqual(values[1], values[2]);
  for (const field of ALL_TOTAL_FIELDS) {
    assert.equal(typeof values[0][field], 'number', `${field} must be a number`);
  }
  const present = values.map((entry) => entry.totalPresent);
  assert.equal(new Set(present).size, present.length, 'every month must have a distinct totalPresent');
  const expected = values.reduce((sum, entry) => sum + entry.expectedWorkingDays, 0);
  assert.ok(present.every((value) => value < expected), 'no single month equals the whole sum');
});
