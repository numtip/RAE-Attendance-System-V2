/**
 * R-03 document/writer level tests: the pure presentation layer, the zero-dependency XLSX container and the
 * Thai line-breaking used by the PDF.
 *
 * These tests deliberately do not trust the writer's own description of itself: the `.xlsx` is unpacked here
 * from its local file headers, every part is inflated with `zlib.inflateRawSync`, and the CRC-32 recorded in
 * each header is recomputed over the uncompressed bytes. If the container were not a real ZIP (or the CRC
 * table were wrong), Excel would refuse the file — a unit test that only checked "a buffer came back" would
 * not notice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
  THAI_MONTHS,
  THAI_MONTHS_SHORT,
  THAI_DAY_NAMES,
  STATUS_LABEL_TH,
  DAY_STATUS_LABEL_TH,
  DRAFT_LABEL,
  DRAFT_WATERMARK_TEXT,
  DRAFT_NOTE_TH,
  REPORT_TITLE_BY_KIND,
  toBuddhistYear,
  formatThaiDate,
  formatThaiDateTime,
  formatClock,
  labelOf,
  statusReasonToThai,
  buildExportModel,
} = require('../src/domain/attendanceReportPresentation');
const { writeXlsx, crc32, escapeXml, columnName } = require('../src/services/export/xlsxWriter');
const { wrapThai, formatCell } = require('../src/services/export/pdfRenderer');

const ZIP_LOCAL_HEADER = 0x04034B50;

// --- the pure presentation layer ---------------------------------------------------------------

test('Thai month, day and status vocabularies are complete and indexed the way callers use them', () => {
  assert.equal(THAI_MONTHS.length, 13, 'index 1-12 so a month number indexes directly');
  assert.equal(THAI_MONTHS[3], 'มีนาคม');
  assert.equal(THAI_MONTHS_SHORT[3], 'มี.ค.');
  assert.equal(THAI_MONTHS_SHORT.length, 13);
  assert.equal(THAI_DAY_NAMES.length, 7);
  assert.equal(THAI_DAY_NAMES[0], 'จันทร์', 'ISO weekday 1 is Monday');
  assert.equal(THAI_DAY_NAMES[6], 'อาทิตย์');

  // Every ReportComputationStatus, including this layer's own `not_derived`, has a Thai label.
  for (const status of [
    'calculated', 'no_data', 'insufficient_data', 'partial', 'pending_policy', 'failed', 'not_derived',
  ]) {
    assert.equal(typeof STATUS_LABEL_TH[status], 'string', `${status} needs a Thai label`);
    assert.ok(STATUS_LABEL_TH[status].length > 0);
  }
  for (const status of ['present', 'late', 'absent', 'leave', 'holiday', 'pending']) {
    assert.equal(typeof DAY_STATUS_LABEL_TH[status], 'string');
  }
  assert.equal(DRAFT_LABEL, 'DRAFT');
  assert.equal(DRAFT_WATERMARK_TEXT, 'ข้อมูลยังไม่สมบูรณ์');
  assert.ok(DRAFT_NOTE_TH.includes('ฉบับร่าง'));
  assert.deepEqual(Object.keys(REPORT_TITLE_BY_KIND).sort(), ['academic_year', 'day', 'month']);
});

test('Buddhist Era is display only', () => {
  assert.equal(toBuddhistYear(2026), 2569);
  assert.equal(toBuddhistYear('2026'), 2569);
  assert.equal(toBuddhistYear(null), null);
  assert.equal(formatThaiDate('2026-03-02'), '2 มีนาคม 2569');
  assert.equal(formatThaiDate('2026-03-02', { short: true }), '02/03/2569');
  assert.equal(formatThaiDate('2028-02-29'), '29 กุมภาพันธ์ 2571');
  assert.equal(formatThaiDate(null), null);
  // An unparseable value is passed through rather than silently invented.
  assert.equal(formatThaiDate('not-a-date'), 'not-a-date');
  // The BE year must never appear in anything machine-readable; the Gregorian form is what survives.
  assert.equal(formatThaiDate('2026-12-31', { short: true }).endsWith('2569'), true);
});

test('Bangkok wall time is used for both an instant and a naive stored value', () => {
  // 04:16:45Z is 11:16 on the same Bangkok day.
  assert.equal(formatThaiDateTime('2026-10-16T04:16:45.000Z'), '16 ตุลาคม 2569 11:16');
  // 21:00Z is 04:00 the NEXT Bangkok day: the +7 offset must be applied, not the UTC day.
  assert.equal(formatThaiDateTime('2026-10-16T21:00:00.000Z'), '17 ตุลาคม 2569 04:00');
  // A naive DATETIME is already Bangkok wall time, so it must not be offset a second time.
  assert.equal(formatThaiDateTime('2026-03-03 08:30:00'), '3 มีนาคม 2569 08:30');
  assert.equal(formatThaiDateTime(new Date('2026-10-16T04:16:45.000Z')), '16 ตุลาคม 2569 11:16');
  assert.equal(formatThaiDateTime(null), null);
  assert.equal(formatThaiDateTime(''), null);
  assert.equal(formatClock('2026-03-03 08:30:00'), '08:30');
  assert.equal(formatClock(null), '—');
});

test('machine status reasons become readable Thai sentences', () => {
  assert.equal(statusReasonToThai('month_partial'), 'เดือนนี้ยังตัดสินไม่ครบทุกวัน จึงยังไม่ใช่ผลสรุป');
  assert.match(statusReasonToThai('unjudged_days:3'), /3 วัน/, 'the numeric detail must survive');
  assert.match(statusReasonToThai('month_not_derived:2026-07'), /2026-07/);
  assert.match(statusReasonToThai('month_pending_policy:2027-01'), /2027-01/);
  assert.equal(statusReasonToThai('academic_year_not_closed'), 'ปีการศึกษานี้ยังไม่สิ้นสุด ช่วงเวลาจึงยังไม่ปิด');
  assert.equal(statusReasonToThai('month_never_derived'), 'เดือนนี้ยังไม่ถูกประมวลผล (ไม่มีข้อมูลที่จัดเก็บ)');
  assert.equal(statusReasonToThai('day_insufficient_data'), 'สถานะรายวัน: ข้อมูลไม่เพียงพอ');
  assert.match(statusReasonToThai('day_reason:single_scan_only'), /single_scan_only/);
  // An unknown code stays traceable instead of being silently dropped.
  assert.match(statusReasonToThai('something_new'), /something_new/);
  assert.equal(statusReasonToThai('   '), null);
  assert.equal(labelOf(STATUS_LABEL_TH, 'nonsense'), 'nonsense');
  assert.equal(labelOf(STATUS_LABEL_TH, null), '—');
});

// --- the canonical export model ----------------------------------------------------------------

function dayPayload({ isFinal = true, computationStatus = 'calculated' } = {}) {
  return {
    report: {
      kind: 'day',
      period: { from: '2026-03-02', to: '2026-03-02', date: '2026-03-02' },
      population: { employees: 1, employeeUid: '22222222-2222-2222-2222-222222222222', dayRows: 1 },
      ruleVersions: ['AR-0001'],
      dateCutoff: '2026-03-02',
      computationStatus,
      isFinal,
      statusReasons: isFinal ? [] : ['day_insufficient_data'],
      caveats: [],
      generatedFrom: 'stored_daily_attendance',
    },
    day: {
      date: '2026-03-02',
      status: 'present',
      computationStatus,
      isFinal,
      checkIn: '2026-03-02 08:29:00',
      checkOut: '2026-03-02 16:31:00',
      lateMinutes: 0,
      earlyMinutes: 0,
      workDuration: 480,
      isLeave: false,
      isOvernight: false,
      ruleVersionCode: 'AR-0001',
      sourceEventCount: 2,
      calculatedAt: '2026-03-02T02:00:00.000Z',
      notes: null,
    },
    rule: {
      ruleVersionCode: 'AR-0001',
      status: 'approved',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      workStart: '08:30:00',
      workEnd: '16:30:00',
      lateAfter: '08:30:00',
      earlyBefore: '16:30:00',
      workDays: [1, 2, 3, 4, 5],
      approvedBy: 'owner:session-2026-10-16',
    },
    employee: { employeeId: 'E-USER', nameTh: 'ผู้ใช้ ตัวอย่าง', department: 'ภาควิชา', position: 'เจ้าหน้าที่' },
  };
}

function monthPayload({ month = {}, statusReasons = [] } = {}) {
  return {
    report: {
      kind: 'month',
      period: { from: '2026-03-01', to: '2026-03-31', year: 2026, month: 3, key: '2026-03' },
      population: { employees: 1, employeeUid: 'u', dayRows: 0 },
      ruleVersions: [],
      dateCutoff: null,
      computationStatus: 'calculated',
      isFinal: true,
      statusReasons,
      caveats: [],
      generatedFrom: 'stored_daily_attendance',
    },
    month,
    days: [],
    dayCounts: { rows: 0, byStatus: {}, byComputationStatus: {} },
  };
}

test('the model carries provenance and an explicit honesty verdict', () => {
  const model = buildExportModel(dayPayload(), { kind: 'day', generatedAt: '2026-10-16T04:16:45.000Z' });
  assert.equal(model.kind, 'day');
  assert.equal(model.title, REPORT_TITLE_BY_KIND.day);
  assert.equal(model.isFinal, true);
  assert.equal(model.watermark, null, 'a final report carries no watermark');
  const meta = Object.fromEntries(model.meta.map((row) => [row.label, row.value]));
  assert.equal(meta['สรุปเป็นผลสรุปได้ (isFinal)'], 'ใช่ (true)');
  assert.equal(meta['วันที่ตัดข้อมูล (dateCutoff)'], '2 มีนาคม 2569');
  assert.equal(meta['เวอร์ชันกฎที่ใช้ (ruleVersions)'], 'AR-0001');
  assert.equal(meta['แหล่งข้อมูล (generatedFrom)'], 'stored_daily_attendance');
  assert.equal(meta['สร้างเอกสารเมื่อ'], '16 ตุลาคม 2569 11:16');
  assert.equal(model.employee.nameTh, 'ผู้ใช้ ตัวอย่าง');
  assert.deepEqual(model.period.label, '2 มีนาคม 2569');

  // caveats and statusReasons are sections of their own and are always present.
  const titles = model.sections.map((section) => section.title);
  assert.ok(titles.some((title) => title.includes('caveats')));
  assert.ok(titles.some((title) => title.includes('statusReasons')));
  assert.deepEqual(model.statusReasons, ['ไม่มี — รายงานนี้เป็นผลสรุปที่สมบูรณ์']);
});

test('a non-final model always carries the DRAFT watermark', () => {
  const model = buildExportModel(
    dayPayload({ isFinal: false, computationStatus: 'insufficient_data' }),
    { kind: 'day' },
  );
  assert.equal(model.isFinal, false);
  assert.equal(model.watermark.label, DRAFT_LABEL);
  assert.equal(model.watermark.text, DRAFT_WATERMARK_TEXT);
  assert.equal(model.watermark.noteTh, DRAFT_NOTE_TH);
  assert.equal(model.statusLabelTh, STATUS_LABEL_TH.insufficient_data);
});

test('a model never invents a number and never turns NULL into zero', () => {
  // The whole point: the figure was not derived, so the export says so rather than printing 0.
  const model = buildExportModel(
    monthPayload({ month: { year: 2026, month: 3, totalWorkHours: 23.75, expectedWorkingDays: null, pendingDays: 0 } }),
    { kind: 'month' },
  );
  const totals = model.sections.find((section) => section.type === 'totals');
  const rows = Object.fromEntries(totals.rows.map((row) => [row.label, row.value]));
  assert.equal(rows['ชั่วโมงทำงานรวม'], 23.75, 'a fractional number keeps its precision');
  assert.equal(rows['วันทำงานที่คาดหมาย'], 'ไม่สามารถคำนวณได้', 'NULL is a sentence, never a zero');
  assert.equal(rows['วันที่ยังรอประมวลผล'], 0, 'a real zero stays a zero');
});

test('an empty payload renders an empty model instead of throwing', () => {
  const model = buildExportModel({}, { kind: 'day' });
  assert.equal(model.isFinal, false, 'a report with no verdict is not final');
  // Fail safe: a payload that never said "final" is watermarked rather than presented as a conclusion.
  assert.equal(model.watermark.label, DRAFT_LABEL);
  assert.deepEqual(model.meta.map((row) => row.label).includes('วันที่ตัดข้อมูล (dateCutoff)'), true);
  assert.ok(model.sections.length >= 2);
  assert.equal(formatCell(undefined), '—');
  assert.equal(formatCell(null), '—');
  assert.equal(formatCell(0), '0');
  assert.equal(formatCell(true), 'ใช่');
});

// --- the XLSX container -------------------------------------------------------------------------

function zipEntriesDetailed(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === ZIP_LOCAL_HEADER) {
    const entry = {
      nameLength: buffer.readUInt16LE(offset + 26),
      extraLength: buffer.readUInt16LE(offset + 28),
      method: buffer.readUInt16LE(offset + 8),
      time: buffer.readUInt16LE(offset + 10),
      date: buffer.readUInt16LE(offset + 12),
      crc: buffer.readUInt32LE(offset + 14),
      compressedSize: buffer.readUInt32LE(offset + 18),
      uncompressedSize: buffer.readUInt32LE(offset + 22),
    };
    entry.name = buffer.toString('utf8', offset + 30, offset + 30 + entry.nameLength);
    const dataStart = offset + 30 + entry.nameLength + entry.extraLength;
    entry.raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    entries.push(entry);
    offset = dataStart + entry.compressedSize;
  }
  // The local entries are followed by the central directory and, at the very end, the EOCD record.
  assert.equal(buffer.readUInt32LE(offset), 0x02014B50, 'the central directory must follow the entries');
  // EOCD from the end: signature -22, disk -18, cd-disk -16, entries-this-disk -14, total-entries -12,
  // central-directory size -10, central-directory offset -6, comment length -2.
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054B50, 'the archive must end with an EOCD');
  assert.equal(buffer.readUInt16LE(buffer.length - 12), entries.length, 'the EOCD entry count');
  assert.equal(buffer.readUInt32LE(buffer.length - 6), offset, 'the EOCD central-directory offset');
  assert.equal(
    buffer.readUInt32LE(buffer.length - 10),
    buffer.length - 22 - offset,
    'the EOCD central-directory size',
  );
  return entries;
}

function workbook(sheets) {
  return { sheets, watermark: null, sheetHeaderText: 'test header' };
}

test('the artifact is a real ZIP whose CRC-32 and compressed sizes check out', () => {
  const buffer = writeXlsx(workbook([
    { name: 'สรุป', columns: [{ header: 'รายการ', width: 40, role: 'label' }, { header: 'ค่า', width: 20 }], rows: [['วันทำงาน', 5], ['ชั่วโมง', 23.75]] },
    { name: 'รายวัน', columns: [{ header: 'วันที่', width: 12 }, { header: 'นาที', width: 8, type: 'number' }], rows: [['02/03/2569', 15]] },
  ]));

  assert.equal(buffer.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004', 'the local file header signature');
  const entries = zipEntriesDetailed(buffer);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]);

  for (const entry of entries) {
    assert.equal(entry.method, 8, `${entry.name} must be DEFLATE`);
    const inflated = zlib.inflateRawSync(entry.raw);
    assert.equal(inflated.length, entry.uncompressedSize, `${entry.name} uncompressed size`);
    assert.equal(crc32(inflated), entry.crc, `${entry.name} CRC-32 must match the header`);
  }

  // The content-types part really is the OOXML one, inflated by us rather than by the writer.
  const contentTypes = zlib.inflateRawSync(entries[0].raw).toString('utf8');
  assert.ok(contentTypes.includes('xl/workbook.xml'));
  assert.ok(contentTypes.includes('xl/styles.xml'));
  assert.ok(contentTypes.includes('xl/worksheets/sheet1.xml'));
  assert.ok(contentTypes.includes('xl/worksheets/sheet2.xml'));
  assert.ok(contentTypes.includes('workbook.xml.rels') === false, 'defaults cover the rels part');

  const workbookXml = zlib.inflateRawSync(entries[2].raw).toString('utf8');
  assert.ok(workbookXml.includes('_xlnm.Print_Titles'), 'the header row must repeat on every printed page');
  // This workbook has a header line and no watermark, so the table header lands on row 3.
  assert.ok(workbookXml.includes('$3:$3'), 'the print-titles row is the table header row');

  const sheet1 = zlib.inflateRawSync(entries[5].raw).toString('utf8');
  assert.ok(sheet1.includes('t="inlineStr"'), 'strings are inline, so no sharedStrings part is needed');
  assert.ok(sheet1.includes('<v>23.75</v>'), 'a number is written as a number');
  assert.ok(sheet1.includes('<v>5</v>'));
  assert.ok(sheet1.includes('fitToWidth="1"'));
  assert.ok(sheet1.includes('paperSize="9"'), 'A4');
  assert.ok(sheet1.includes('state="frozen"'));
  assert.equal(sheet1.includes('sharedStrings'), false);
});

test('deflateRaw round-trips byte-for-byte through the stored entry', () => {
  const original = Buffer.from('<t>ทดสอบ &amp; "x"</t>', 'utf8');
  assert.deepEqual(zlib.inflateRawSync(zlib.deflateRawSync(original)), original);

  // And the same property holds for what the writer actually stored.
  const buffer = writeXlsx(workbook([
    { name: 'a', columns: [{ header: 'x', width: 10 }], rows: [['ทดสอบ & <x> "q" \'a\'']] },
  ]));
  const entry = zipEntriesDetailed(buffer).find((item) => item.name === 'xl/worksheets/sheet1.xml');
  const inflated = zlib.inflateRawSync(entry.raw);
  assert.equal(inflated.length, entry.uncompressedSize);
  assert.equal(inflated.toString('utf8').includes('&amp; &lt;x&gt; &quot;q&quot; &apos;a&apos;'), true);
});

test('XML escaping and illegal control characters cannot break the file', () => {
  assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(escapeXml('a\u0000b\u0007c\td'), 'abc\td', 'illegal control characters are stripped');
  assert.equal(escapeXml('ทดสอบ'), 'ทดสอบ', 'Thai is passed through unchanged');

  const buffer = writeXlsx(workbook([
    {
      name: 'a',
      columns: [{ header: 'x', width: 10 }],
      rows: [['& < > " \' \u0000\u0001\u001F'], ['ok']],
    },
  ]));
  const xml = zlib.inflateRawSync(
    zipEntriesDetailed(buffer).find((entry) => entry.name === 'xl/worksheets/sheet1.xml').raw,
  ).toString('utf8');
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), false, 'no control character survives');
  assert.equal((xml.match(/<t[ >]/g) || []).length, (xml.match(/<\/t>/g) || []).length);
  assert.ok(xml.includes('&amp; &lt; &gt; &quot; &apos;'));
});

test('the same model and zipDate produce byte-identical output', () => {
  const description = () => workbook([
    { name: 'สรุป', columns: [{ header: 'รายการ', width: 40 }, { header: 'ค่า', width: 20 }], rows: [['a', 1], ['b', 'ทดสอบ']] },
  ]);
  const first = writeXlsx(description());
  const second = writeXlsx(description());
  assert.deepEqual(first, second, 'output must be deterministic by default');
  assert.equal(first.equals(second), true);

  const sameDate = writeXlsx({ ...description(), zipDate: new Date(Date.UTC(2026, 2, 2, 0, 0, 0)) });
  const sameDateAgain = writeXlsx({ ...description(), zipDate: new Date(Date.UTC(2026, 2, 2, 0, 0, 0)) });
  assert.equal(sameDate.equals(sameDateAgain), true);
  assert.equal(first.equals(sameDate), false, 'zipDate must actually reach the archive header');

  // ...and the pinned date is what a ZIP reader sees.
  const entry = zipEntriesDetailed(sameDate)[0];
  assert.equal(entry.date >> 9, 2026 - 1980);
  assert.equal((entry.date >> 5) & 0x0F, 3);
  assert.equal(entry.date & 0x1F, 2);
});

test('formula-looking values are written as inert inline strings', () => {
  const probes = ['=1+1', '+1', '-1', '@SUM(A1)', "=cmd|' /C calc'!A0"];
  const buffer = writeXlsx(workbook([
    { name: 'a', columns: [{ header: 'x', width: 10 }], rows: probes.map((probe) => [probe]) },
  ]));
  const xml = zlib.inflateRawSync(
    zipEntriesDetailed(buffer).find((entry) => entry.name === 'xl/worksheets/sheet1.xml').raw,
  ).toString('utf8');
  assert.equal(xml.includes('<f>'), false, 'no formula element may ever be emitted');
  assert.equal(xml.includes('<f '), false);
  for (const probe of probes) {
    assert.equal(xml.includes(`t="inlineStr"`), true);
    assert.equal(xml.includes(escapeXml(probe)), true, `${probe} must be stored literally`);
  }
  assert.equal(xml.includes('<v>'), false, 'a formula-looking string must not become a numeric cell');
});

test('empty and hostile inputs render without throwing', () => {
  assert.ok(writeXlsx({}).length > 0);
  assert.ok(writeXlsx({ sheets: [] }).length > 0);
  assert.ok(writeXlsx(workbook([{ name: 'x', columns: [], rows: [] }])).length > 0);
  assert.ok(writeXlsx(workbook([{ name: 'x', columns: [{ header: 'h' }], rows: [] }])).length > 0);
  assert.ok(writeXlsx(workbook([
    { name: 'x', columns: [{ header: 'h', width: 0 }], rows: [[null, undefined, '', NaN, Infinity]] },
  ])).length > 0);

  // Excel forbids []:*?/\ in a sheet name, and a name longer than 31 characters.
  const buffer = writeXlsx(workbook([
    { name: 'a[b]:c?d/e\\fghijklmnopqrstuvwxyz0123456789', columns: [{ header: 'h', width: 10 }], rows: [['v']] },
  ]));
  const workbookXml = zlib.inflateRawSync(
    zipEntriesDetailed(buffer).find((entry) => entry.name === 'xl/workbook.xml').raw,
  ).toString('utf8');
  const name = /<sheet name="([^"]+)"/.exec(workbookXml)[1];
  assert.equal(/[[\]:*?/\\]/.test(name), false, `illegal characters must be removed from ${name}`);
  assert.ok(name.length <= 31);
});

test('a watermarked workbook carries DRAFT in a banner row and in the print header', () => {
  const buffer = writeXlsx({
    ...workbook([{ name: 'a', columns: [{ header: 'h', width: 10 }], rows: [['v']] }]),
    watermark: { label: DRAFT_LABEL, text: DRAFT_WATERMARK_TEXT, noteTh: DRAFT_NOTE_TH },
  });
  const xml = zlib.inflateRawSync(
    zipEntriesDetailed(buffer).find((entry) => entry.name === 'xl/worksheets/sheet1.xml').raw,
  ).toString('utf8');
  assert.ok(xml.includes('DRAFT — ข้อมูลยังไม่สมบูรณ์'), 'the banner row');
  assert.ok(xml.includes(DRAFT_NOTE_TH), 'the Thai note');
  assert.ok(xml.includes('&amp;C&amp;&quot;Sarabun,Bold&quot;'), 'the print header keeps the DRAFT marker');
  assert.ok(xml.includes('หน้า &amp;P / &amp;N'), 'page numbers in the print footer');
});

test('column names and the CRC table behave like the standard', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnName(702), 'AAA');
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xCBF43926, 'the canonical CRC-32 check value');
});

// --- Thai line breaking ------------------------------------------------------------------------

test('Thai text wraps without overflowing and without splitting a cluster', () => {
  const text = 'รายงานการมาทำงานรายเดือนของพนักงานทดสอบระบบ';
  const maxWidth = 120;
  const measure = (value) => Array.from(value).length * 10;
  const lines = wrapThai(text, maxWidth, measure);
  assert.ok(lines.length > 1, 'a long unspaced Thai sentence must be broken into several lines');
  for (const line of lines) {
    assert.ok(measure(line) <= maxWidth, `line wider than the column: ${line}`);
    assert.equal(/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(line), false, `orphaned combining mark: ${line}`);
  }
  assert.equal(lines.join(''), text, 'wrapping must not lose or duplicate a character');
});

test('Latin text wraps on spaces and never starts a line with one', () => {
  const text = 'Covered by an approved holiday calendar for the whole period under review today.';
  const measure = (value) => value.length * 10;
  const lines = wrapThai(text, 200, measure);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= 20, `line too wide: ${line}`);
    assert.equal(/^\s/.test(line), false, 'a line never starts with a space');
  }
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('a single word longer than the column is hard-split, never overflown', () => {
  const word = 'expected_working_days_and_more';
  const measure = (value) => value.length * 10;
  for (const prefix of ['', 'so ', 'so expected ']) {
    const lines = wrapThai(`${prefix}${word}`, 200, measure);
    for (const line of lines) {
      assert.ok(line.length <= 20, `line too wide: ${line} (prefix ${JSON.stringify(prefix)})`);
    }
    // Only the spaces consumed at a line break disappear; no letter is lost or duplicated.
    assert.equal(lines.join('').replace(/\s+/g, ''), `${prefix}${word}`.replace(/\s+/g, ''));
  }
});

test('wrapping never emits a line wider than the column, whatever the input', () => {
  const measure = (value) => Array.from(value).length * 10;
  for (const value of [
    '',
    '   ',
    'a',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'ทดสอบ',
    'ทดสอบ ทดสอบ',
    'one two three four five six seven',
    'ผสม Thai and Latin 12345 together',
    'บรรทัดแรก\nบรรทัดที่สอง',
  ]) {
    for (const width of [10, 40, 120, 400]) {
      const lines = wrapThai(value, width, measure);
      assert.ok(lines.length >= 1, `${JSON.stringify(value)} produced no lines`);
      for (const line of lines) {
        assert.ok(
          Array.from(line).length * 10 <= width || Array.from(line).length <= 1,
          `${JSON.stringify(value)} at ${width} produced an over-wide line: ${line}`,
        );
      }
      if (value.includes('\n')) {
        assert.ok(lines.length >= value.split('\n').length, 'explicit newlines must be preserved');
      }
    }
  }
});
