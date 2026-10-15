const { HttpError } = require('../utils/httpError');

const CSV_PARSER_VERSION = 'facescan-csv/v1';

/**
 * CANDIDATE header contract. These alias vocabularies mirror exactly what
 * `normalizeCheckinoutRow` already accepts (see ./facescanIngestion.js).
 * They are NOT verified against a real HIP FaceScan export: the real export
 * header names are unknown, so callers must be able to override the map.
 */
const CHECKINOUT_COLUMNS = Object.freeze({
  facescanId: ['USERID', 'userId', 'facescan_id', 'facescanId'],
  checkTime: ['CHECKTIME', 'checkTime', 'check_time'],
  checkType: ['CHECKTYPE', 'checkType', 'check_type'],
  verifyCode: ['VERIFYCODE', 'verifyCode', 'verify_code'],
  sensorId: ['SensorID', 'sensorId', 'sensor_id'],
  workCode: ['WorkCode', 'workCode', 'work_code'],
});

const REQUIRED_COLUMNS = Object.freeze(['facescanId', 'checkTime']);

/** Canonical alias key emitted for each field: the first alias the normalizer reads. */
const CANONICAL_KEYS = Object.freeze({
  facescanId: CHECKINOUT_COLUMNS.facescanId[0],
  checkTime: CHECKINOUT_COLUMNS.checkTime[0],
  checkType: CHECKINOUT_COLUMNS.checkType[0],
  verifyCode: CHECKINOUT_COLUMNS.verifyCode[0],
  sensorId: CHECKINOUT_COLUMNS.sensorId[0],
  workCode: CHECKINOUT_COLUMNS.workCode[0],
});

const SKIP_REASON_MISSING_REQUIRED = 'missing_required_value';

/**
 * RFC4180-ish CSV reader. Pure: string in, structures out. No fs, no network.
 * `lineNumbers[i]` is the ORIGINAL 1-based physical line on which data row i started.
 */
function parseCsv(text, { delimiter = ',' } = {}) {
  if (text == null) throw new HttpError(400, 'CSV_EMPTY', 'The CSV file contains no rows');
  let source = typeof text === 'string' ? text : String(text);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1); // strip leading UTF-8 BOM

  const records = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let mode = 'start'; // start | quoted | afterquote
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const pushCell = () => {
    cells.push(quoted ? cell : cell.trim()); // trim only unquoted surrounding whitespace
    cell = '';
    quoted = false;
  };
  const pushRecord = () => {
    records.push({ cells, line: recordLine });
    cells = [];
    cell = '';
    quoted = false;
    mode = 'start';
  };

  while (i < source.length) {
    const ch = source[i];
    if (mode === 'quoted') {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"'; // doubled quote -> literal quote
          i += 2;
          continue;
        }
        mode = 'afterquote';
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1; // embedded newline must not corrupt numbering
      cell += ch;
      i += 1;
      continue;
    }
    if (mode === 'afterquote' && ch !== delimiter && ch !== '\n' && ch !== '\r') {
      // tolerate padding after a closing quote; ignore whitespace, keep anything else
      if (ch !== ' ' && ch !== '\t') cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      mode = 'quoted';
      cell = '';
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      mode = 'start';
      i += 1;
      continue;
    }
    if (ch === '\r' && source[i + 1] === '\n') {
      pushCell();
      pushRecord();
      i += 2;
      line += 1;
      recordLine = line;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      pushCell();
      pushRecord();
      i += 1;
      line += 1;
      recordLine = line;
      continue;
    }
    cell += ch;
    i += 1;
  }

  if (mode === 'quoted') {
    throw new HttpError(400, 'CSV_UNTERMINATED_QUOTE', 'The CSV contains an unterminated quoted field');
  }
  if (cells.length > 0 || cell !== '') {
    pushCell();
    pushRecord();
  }

  const meaningful = records.filter((record) => !(record.cells.length === 1 && record.cells[0] === ''));
  if (meaningful.length === 0) {
    throw new HttpError(400, 'CSV_EMPTY', 'The CSV file contains no rows');
  }
  const header = meaningful[0].cells;
  const data = meaningful.slice(1);
  if (data.length === 0) {
    throw new HttpError(400, 'CSV_EMPTY', 'The CSV file contains no rows');
  }

  return {
    header,
    rows: data.map((record) => record.cells),
    lineNumbers: data.map((record) => record.line),
  };
}

function headerIndexOf(header, actual) {
  const target = String(actual).trim().toLowerCase();
  const columns = Array.isArray(header) ? header : [];
  for (let i = 0; i < columns.length; i += 1) {
    if (String(columns[i] ?? '').trim().toLowerCase() === target) return i;
  }
  return -1;
}

/**
 * Map canonical fields onto actual header names. Case-insensitive, trimmed.
 * `overrides` pins a canonical field to an exact header name (e.g. Badgenumber).
 */
function resolveColumnMap(header, { overrides = {} } = {}) {
  const columns = (Array.isArray(header) ? header : []).map((value) => String(value ?? '').trim());
  const lower = columns.map((value) => value.toLowerCase());
  const usedIndexes = new Set();
  const map = {};

  for (const field of Object.keys(CHECKINOUT_COLUMNS)) {
    const override = overrides ? overrides[field] : null;
    if (override != null && String(override).trim() !== '') {
      const idx = lower.indexOf(String(override).trim().toLowerCase());
      if (idx !== -1) {
        map[field] = columns[idx];
        usedIndexes.add(idx);
      }
      continue;
    }
    for (const alias of CHECKINOUT_COLUMNS[field]) {
      const idx = lower.indexOf(alias.toLowerCase());
      if (idx !== -1) {
        map[field] = columns[idx];
        usedIndexes.add(idx);
        break;
      }
    }
  }

  const missing = REQUIRED_COLUMNS.filter((field) => !(field in map));
  const ignoredHeaders = columns.filter((_, idx) => !usedIndexes.has(idx));
  return { map, missing, ignoredHeaders };
}

/**
 * Structural gate. Runs BEFORE any row is touched so a bad header can never
 * produce a partial import. Only canonical field names are exposed.
 */
function assertRequiredColumns(header, { overrides = {} } = {}) {
  const resolved = resolveColumnMap(header, { overrides });
  if (resolved.missing.length > 0) {
    throw new HttpError(400, 'CSV_HEADER_MISSING', 'Required CSV columns are missing', {
      missing: resolved.missing,
    });
  }
  return resolved;
}

/**
 * Project CSV rows onto the six canonical checkinout keys the normalizer reads.
 * Only those six keys are ever emitted; extra CSV columns are dropped.
 */
function toCheckinoutRows({ header, rows, map, maxRows = 20000, lineNumbers = null } = {}) {
  const dataRows = Array.isArray(rows) ? rows : [];
  if (dataRows.length > maxRows) {
    throw new HttpError(400, 'CSV_TOO_LARGE', 'The CSV exceeds the row limit', { maxRows });
  }

  const fields = Object.keys(CHECKINOUT_COLUMNS);
  const indexes = {};
  for (const field of fields) {
    indexes[field] = map && map[field] != null ? headerIndexOf(header, map[field]) : -1;
  }

  const emitted = [];
  const emittedLines = [];
  const skipped = [];

  dataRows.forEach((row, index) => {
    const lineNumber = Array.isArray(lineNumbers) && lineNumbers[index] != null
      ? lineNumbers[index]
      : index + 1;

    const values = {};
    let missingRequired = false;
    for (const field of fields) {
      const idx = indexes[field];
      const value = idx >= 0 && Array.isArray(row) && idx < row.length
        ? String(row[idx] ?? '').trim()
        : '';
      values[field] = value;
      if (value === '' && REQUIRED_COLUMNS.includes(field)) missingRequired = true;
    }

    if (missingRequired) {
      skipped.push({ lineNumber, reason: SKIP_REASON_MISSING_REQUIRED });
      return;
    }

    const out = {};
    for (const field of fields) {
      out[CANONICAL_KEYS[field]] = values[field];
    }
    emitted.push(out);
    emittedLines.push(lineNumber);
  });

  return { rows: emitted, skipped, lineNumbers: emittedLines };
}

module.exports = {
  CSV_PARSER_VERSION,
  CHECKINOUT_COLUMNS,
  REQUIRED_COLUMNS,
  parseCsv,
  resolveColumnMap,
  assertRequiredColumns,
  toCheckinoutRows,
};
