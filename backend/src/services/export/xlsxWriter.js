/**
 * R-03 XLSX writer. ZERO DEPENDENCIES. Pure: same input -> same bytes.
 *
 * Why a hand-written writer instead of a library:
 *
 *   `exceljs` (the only serious candidate) was evaluated and REJECTED. Its latest release (4.4.0) pulls in
 *   186 packages and drags deprecated `glob@7`, `fstream` and `uuid@8` into the tree, plus an unresolved
 *   moderate advisory whose only npm-suggested "fix" is a breaking downgrade. This slice exports two tables
 *   and needs no formula engine, no charting and no streaming writer, so a real ZIP container built with
 *   `node:zlib` is the smaller, auditable option — and `npm audit` stays clean.
 *
 * What it produces is a genuine ECMA-376 package: a ZIP (local file headers + central directory + EOCD, with
 * a real CRC-32) containing `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
 * `xl/_rels/workbook.xml.rels`, `xl/styles.xml` and one `xl/worksheets/sheetN.xml` per sheet. Strings are
 * written as INLINE strings (`t="inlineStr"`), which is why no `sharedStrings` part exists.
 *
 * FORMULA-INJECTION SAFETY: Excel treats an `inlineStr` cell as a literal string, so a value that starts
 * with `=`, `+`, `-` or `@` is displayed and never executed. We rely on that deliberately — we do NOT prefix
 * an apostrophe (it would change the visible text) and we never emit `<f>`. `tests/attendanceExport*.test.js`
 * proves it.
 */
const zlib = require('node:zlib');

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** The DOS epoch: the earliest date a ZIP can express, and therefore the deterministic default mtime. */
const DOS_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/** Style indices into `cellXfs` in `styles.xml`. Keep this table next to the stylesheet it indexes. */
const STYLE = Object.freeze({
  DEFAULT: 0,
  TITLE: 1,
  BANNER: 2,
  HEADER: 3,
  TEXT: 4,
  NUMBER: 5,
  LABEL: 6,
});

// --- CRC-32 (the standard table-based implementation used by ZIP) --------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** ZIP stores an mtime in MS-DOS format. `zipDate` lets a test pin it so output is byte-stable. */
function dosDateTime(zipDate) {
  const parsed = zipDate instanceof Date ? zipDate : new Date(zipDate ?? DOS_EPOCH.getTime());
  const date = Number.isNaN(parsed.getTime()) ? DOS_EPOCH : parsed;
  const year = Math.max(1980, date.getUTCFullYear());
  const time = ((date.getUTCHours() & 0x1F) << 11)
    | ((date.getUTCMinutes() & 0x3F) << 5)
    | (Math.floor(date.getUTCSeconds() / 2) & 0x1F);
  const day = ((year - 1980) << 9)
    | (((date.getUTCMonth() + 1) & 0x0F) << 5)
    | (date.getUTCDate() & 0x1F);
  return { time, day };
}

/** One stored entry: local file header + name + deflated bytes, tracked for the central directory. */
function buildZip(entries, zipDate) {
  const { time, day } = dosDateTime(zipDate);
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    // `deflateRawSync` is exactly ZIP method 8: raw DEFLATE with no zlib wrapper.
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // general purpose flag: names are UTF-8
    header.writeUInt16LE(8, 8); // method: deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014B50, 0);
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed to extract
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(day, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra field length
    directory.writeUInt16LE(0, 32); // comment length
    directory.writeUInt16LE(0, 34); // disk number start
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += header.length + name.length + compressed.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, eocd]);
}

// --- XML ------------------------------------------------------------------------------------------

/** Characters illegal in XML 1.0 (control chars other than tab/newline/CR) would make the file unopenable. */
function stripIllegalXml(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function escapeXml(value) {
  return stripIllegalXml(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0-based column index -> 'A', 'B', ... 'AA'. */
function columnName(index) {
  let remaining = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

/**
 * A cell is a NUMBER only when the value really is a finite number and the column did not declare itself as
 * text. Everything else is an inline string, which is what keeps a `=...` value inert.
 */
function resolveCell(value, column) {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  if (isNumber && column?.type !== 'text') {
    return { kind: 'number', text: String(value) };
  }
  if (value == null) return { kind: 'inlineStr', text: '' };
  if (typeof value === 'boolean') return { kind: 'inlineStr', text: value ? 'TRUE' : 'FALSE' };
  return { kind: 'inlineStr', text: String(value) };
}

function styleFor(column, cell) {
  if (column?.role === 'label') return STYLE.LABEL;
  if (cell.kind === 'number') return STYLE.NUMBER;
  return STYLE.TEXT;
}

function buildRowXml(rowNumber, values, stylePicker) {
  const cells = values.map((value, index) => {
    const column = stylePicker.columns?.[index];
    const cell = resolveCell(value, column);
    const ref = `${columnName(index)}${rowNumber}`;
    const style = stylePicker.style(column, cell);
    if (cell.kind === 'number') {
      return `<c r="${ref}" s="${style}"><v>${cell.text}</v></c>`;
    }
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
  });
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

function sanitizeSheetName(name, index) {
  const cleaned = stripIllegalXml(String(name ?? '')).replace(/[[\]:*?/\\]/g, ' ').trim();
  return (cleaned || `Sheet${index + 1}`).slice(0, 31);
}

function buildSheetXml(sheet, { watermark, sheetHeaderText }) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];

  const parts = [];
  let rowNumber = 1;

  if (sheetHeaderText) {
    parts.push(buildRowXml(rowNumber, [sheetHeaderText], { columns, style: () => STYLE.TITLE }));
    rowNumber += 1;
  }
  if (watermark) {
    const banner = `${watermark.label} — ${watermark.text}`;
    parts.push(buildRowXml(rowNumber, [banner, watermark.noteTh], {
      columns,
      style: () => STYLE.BANNER,
    }));
    rowNumber += 1;
  }
  rowNumber += 1; // spacer row: keeps the banner visually separate from the table

  const headerRow = rowNumber;
  parts.push(buildRowXml(headerRow, columns.map((column) => column.header ?? ''), {
    columns,
    style: () => STYLE.HEADER,
  }));
  rowNumber += 1;

  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row];
    parts.push(buildRowXml(rowNumber, values, { columns, style: styleFor }));
    rowNumber += 1;
  }

  const colsXml = columns.map((column, index) => {
    const width = Number(column.width);
    const safeWidth = Number.isFinite(width) && width > 0 ? width : 12;
    return `<col min="${index + 1}" max="${index + 1}" width="${safeWidth}" customWidth="1"/>`;
  }).join('');

  // `&L`/`&C`/`&P`/`&N` are Excel's header/footer codes; they are XML-escaped so Excel sees them intact.
  const oddHeader = `&L&8${sheetHeaderText ?? ''}`
    + (watermark ? `&C&"Sarabun,Bold"&10&FF0000${watermark.label} — ${watermark.text}` : '');
  const oddFooter = '&C&8หน้า &P / &N';

  const xml = [
    XML_DECLARATION,
    `<worksheet xmlns="${SPREADSHEET_NS}">`,
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    '<sheetViews><sheetView workbookViewId="0">',
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`,
    `<selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>`,
    '</sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
    colsXml ? `<cols>${colsXml}</cols>` : '',
    `<sheetData>${parts.join('')}</sheetData>`,
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>',
    '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>',
    `<headerFooter><oddHeader>${escapeXml(oddHeader)}</oddHeader>`
      + `<oddFooter>${escapeXml(oddFooter)}</oddFooter></headerFooter>`,
    '</worksheet>',
  ].filter(Boolean).join('');

  return { xml, headerRow };
}

function buildStylesXml() {
  return [
    XML_DECLARATION,
    `<styleSheet xmlns="${SPREADSHEET_NS}">`,
    '<fonts count="4">',
    '<font><sz val="11"/><name val="Sarabun"/></font>',
    '<font><b/><sz val="11"/><name val="Sarabun"/></font>',
    '<font><b/><sz val="14"/><name val="Sarabun"/></font>',
    '<font><b/><color rgb="FFB00020"/><sz val="12"/><name val="Sarabun"/></font>',
    '</fonts>',
    '<fills count="4">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE7E7"/><bgColor indexed="64"/></patternFill></fill>',
    '</fills>',
    '<borders count="2">',
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left style="thin"><color rgb="FFBFBFBF"/></left>'
      + '<right style="thin"><color rgb="FFBFBFBF"/></right>'
      + '<top style="thin"><color rgb="FFBFBFBF"/></top>'
      + '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>',
    '</borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="7">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"'
      + ' applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
      + '<alignment vertical="top" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
      + '<alignment horizontal="right" vertical="top"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"'
      + ' applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
    '</cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

function buildWorkbookXml(sheets) {
  const sheetEntries = sheets.map((sheet, index) => (
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('');
  // `_xlnm.Print_Titles` is how OOXML repeats a header row on every printed page.
  const definedNames = sheets.map((sheet, index) => (
    `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">`
      + `&apos;${escapeXml(sheet.name)}&apos;!$${sheet.headerRow}:$${sheet.headerRow}</definedName>`
  )).join('');
  return [
    XML_DECLARATION,
    `<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${RELATIONSHIP_NS}">`,
    `<sheets>${sheetEntries}</sheets>`,
    definedNames ? `<definedNames>${definedNames}</definedNames>` : '',
    '</workbook>',
  ].filter(Boolean).join('');
}

function buildWorkbookRels(sheetCount) {
  const parts = [];
  for (let index = 0; index < sheetCount; index += 1) {
    parts.push(`<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_NS}/worksheet"`
      + ` Target="worksheets/sheet${index + 1}.xml"/>`);
  }
  parts.push(`<Relationship Id="rId${sheetCount + 1}" Type="${RELATIONSHIP_NS}/styles" Target="styles.xml"/>`);
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">${parts.join('')}</Relationships>`;
}

function buildRootRels() {
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${RELATIONSHIP_NS}/officeDocument" Target="xl/workbook.xml"/>`
    + '</Relationships>';
}

function buildContentTypes(sheetCount) {
  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
  ];
  for (let index = 0; index < sheetCount; index += 1) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${index + 1}.xml"`
      + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
  }
  return [
    XML_DECLARATION,
    `<Types xmlns="${CONTENT_TYPES_NS}">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    overrides.join(''),
    '</Types>',
  ].join('');
}

/**
 * Turn a workbook description into an `.xlsx` buffer.
 *
 * `workbook = { sheets: [{ name, columns: [{ header, width, type, role }], rows: [[...]] }],
 *               watermark, sheetHeaderText, zipDate }`
 *
 * Every sheet carries the header line and, when `watermark` is set, a red `DRAFT` banner row plus the same
 * text in the print header — an incomplete report cannot be printed as if it were final.
 */
function writeXlsx(workbook = {}) {
  const sourceSheets = Array.isArray(workbook.sheets) ? workbook.sheets : [];
  const sheets = sourceSheets.map((sheet, index) => {
    const name = sanitizeSheetName(sheet?.name, index);
    const { xml, headerRow } = buildSheetXml(sheet ?? {}, {
      watermark: workbook.watermark ?? null,
      sheetHeaderText: workbook.sheetHeaderText ?? null,
    });
    return { name, xml, headerRow };
  });

  const entries = [
    { name: '[Content_Types].xml', data: buildContentTypes(sheets.length) },
    { name: '_rels/.rels', data: buildRootRels() },
    { name: 'xl/workbook.xml', data: buildWorkbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: buildWorkbookRels(sheets.length) },
    { name: 'xl/styles.xml', data: buildStylesXml() },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml })),
  ];

  return buildZip(entries, workbook.zipDate ?? DOS_EPOCH);
}

module.exports = {
  writeXlsx,
  crc32,
  escapeXml,
  stripIllegalXml,
  columnName,
  DOS_EPOCH,
};
