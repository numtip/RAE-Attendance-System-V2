const { createHash } = require('node:crypto');
const { isCalendarDate } = require('../domain/attendanceRuleEngine');

/**
 * HIP FaceScan file -> rawRows for `facescanRawIngestion.ingestBatch`.
 *
 * This is the `csvExport` adapter from docs/HIP_DEVICE_INGESTION.md §6: it only has to produce
 * `{ facescan_id, scan_datetime, scan_type }`. The vendor's own export layout is still UNKNOWN (owner
 * question, §8 Q3), so this reads the seam's canonical columns by header NAME and nothing else. A
 * vendor file must be mapped to these headers before it reaches this function; guessing the vendor
 * layout here would be inventing a contract.
 *
 * Rules (§7 QA gates):
 *   - the whole file is validated before anything is written; one bad line refuses the file, so a
 *     batch is never half-imported;
 *   - a file with no scan rows is refused — an empty batch is indistinguishable from "no punches";
 *   - times are Asia/Bangkok wall clock. A value with a zone (`Z`, `+07:00`) is refused rather than
 *     silently reinterpreted, and a Buddhist-era year is converted (`DD/MM/BBBB` -> CE);
 *   - only facescan_id, the timestamp and the scan type leave this module. Every other column
 *     (names, photos, anything else an export carries) is dropped, never copied into raw_payload.
 */

const REQUIRED = ['facescan_id', 'scan_datetime'];
const OPTIONAL = ['scan_type'];
const FACESCAN_ID_MAX = 64; // staging_facescan_raw.facescan_id VARCHAR(64)
const MAX_REPORTED_ISSUES = 20;

class FacescanFileError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'FacescanFileError';
    this.code = 'FACESCAN_FILE_INVALID';
    this.issues = issues;
  }
}

function decodeBuffer(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  const buffer = Buffer.from(input);
  const text = buffer.toString('utf8');
  if (text.includes('�')) {
    // Not UTF-8 (e.g. a cp874 export). Decoding it as something else would be a guess.
    throw new FacescanFileError('file is not UTF-8; re-export or convert it to UTF-8 first');
  }
  return text.replace(/^\uFEFF/, '');
}

/** RFC-4180: quoted fields, doubled quotes, embedded commas, CRLF/LF. Rows keep their line number. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = '';
      line += 1;
      rowLine = line;
    } else {
      field += char;
    }
  }
  if (quoted) throw new FacescanFileError('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  return rows.filter((entry) => entry.cells.some((cell) => cell.trim() !== ''));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Bangkok wall clock -> `YYYY-MM-DD HH:MM:SS`, or null when it is not one.
 * Accepted: `YYYY-MM-DD HH:MM[:SS]` (CE, also with a `T`) and `DD/MM/BBBB HH:MM[:SS]` (Buddhist era).
 */
function parseScanDatetime(value) {
  const text = String(value ?? '').trim();
  let year;
  let month;
  let day;
  let rest;
  let match = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/.exec(text);
  if (match) {
    [, year, month, day, rest] = match;
    year = Number(year);
    if (year >= 2400) return null; // a BE year in ISO shape is ambiguous; refuse, do not guess
  } else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (.+)$/.exec(text);
    if (!match) return null;
    [, day, month, year, rest] = match;
    year = Number(year);
    if (year < 2400) return null; // slash dates in HIP exports are Buddhist era (FY2569 report §2.3)
    year -= 543;
  }
  const time = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(rest.trim());
  if (!time) return null; // includes any zone suffix: Z, +07:00, ...
  const date = `${year}-${pad(Number(month))}-${pad(Number(day))}`;
  if (!isCalendarDate(date)) return null;
  return `${date} ${pad(Number(time[1]))}:${time[2]}:${time[3] ?? '00'}`;
}

function parseScanType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return 'unknown';
  if (text === 'in' || text === 'out' || text === 'unknown') return text;
  return null;
}

/**
 * @param {Buffer|string} input file content
 * @returns {{ rows: Array<{facescanId, scanDatetime, scanType, payload}>, contentSha256: string }}
 * @throws {FacescanFileError} with `issues[]` ({ line, message }) when any line is invalid
 */
function parseFacescanCsvExport(input) {
  const text = decodeBuffer(input);
  const contentSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const records = parseCsv(text);
  if (records.length === 0) throw new FacescanFileError('file is empty');

  const header = records[0].cells.map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new FacescanFileError(`header is missing required column(s): ${missing.join(', ')}`);
  }
  const duplicated = [...REQUIRED, ...OPTIONAL].filter((name) => header.indexOf(name) !== header.lastIndexOf(name));
  if (duplicated.length > 0) {
    throw new FacescanFileError(`header repeats column(s): ${duplicated.join(', ')}`);
  }
  const index = Object.fromEntries([...REQUIRED, ...OPTIONAL].map((name) => [name, header.indexOf(name)]));

  const rows = [];
  const issues = [];
  for (const { line, cells } of records.slice(1)) {
    const cell = (name) => (index[name] >= 0 ? String(cells[index[name]] ?? '').trim() : '');
    const facescanId = cell('facescan_id');
    const scanDatetime = parseScanDatetime(cell('scan_datetime'));
    const scanType = parseScanType(cell('scan_type'));
    if (!facescanId) issues.push({ line, message: 'facescan_id is empty' });
    else if (facescanId.length > FACESCAN_ID_MAX) issues.push({ line, message: `facescan_id exceeds ${FACESCAN_ID_MAX} characters` });
    if (!scanDatetime) issues.push({ line, message: 'scan_datetime is not a Bangkok wall-clock date-time' });
    if (!scanType) issues.push({ line, message: 'scan_type must be in, out, unknown or empty' });
    if (facescanId && facescanId.length <= FACESCAN_ID_MAX && scanDatetime && scanType) {
      rows.push({ facescanId, scanDatetime, scanType, payload: { sourceLine: line } });
    }
  }

  if (issues.length > 0) {
    throw new FacescanFileError(
      `${issues.length} invalid line(s); the file was not imported`,
      issues.slice(0, MAX_REPORTED_ISSUES),
    );
  }
  if (rows.length === 0) throw new FacescanFileError('file has a header but no scan rows');
  return { rows, contentSha256 };
}

module.exports = { parseFacescanCsvExport, parseScanDatetime, FacescanFileError };
