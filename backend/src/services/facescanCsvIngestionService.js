const { createHash } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { createFacescanIngestionService } = require('./facescanIngestionService');
const {
  normalizeCheckinoutRow,
  buildSourceEventKey,
} = require('../domain/facescanIngestion');
const {
  CSV_PARSER_VERSION,
  parseCsv,
  assertRequiredColumns,
  toCheckinoutRows,
} = require('../domain/facescanCsv');

const REPORT_LIST_CAP = 100;

function toBytes({ text, buffer } = {}) {
  if (buffer != null) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (text != null) return Buffer.from(String(text), 'utf8');
  return Buffer.alloc(0);
}

/** Reduce an arbitrary path to its base name (handles both '/' and '\\'). */
function toBaseName(fileName) {
  if (fileName == null) return null;
  const text = String(fileName).trim();
  if (!text) return null;
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

function createFacescanCsvIngestionService({ repositories }) {
  const ingestion = createFacescanIngestionService({ repositories });

  /**
   * Parse + structurally validate + analyse the file WITHOUT writing anything.
   * Returns the report plus the canonical rows for the real (non-dry) path.
   */
  function analyze({ text, buffer, fileName, columnMap = {} }) {
    const bytes = toBytes({ text, buffer });
    const sourceText = text != null ? String(text) : bytes.toString('utf8');
    const inputSha256 = createHash('sha256').update(bytes).digest('hex');
    const baseFileName = toBaseName(fileName);

    // Structural failures (empty file, missing header, too many rows) throw here,
    // before any batch exists, so they can never leave a partial import behind.
    const parsed = parseCsv(sourceText);
    const { map, ignoredHeaders } = assertRequiredColumns(parsed.header, { overrides: columnMap });
    const converted = toCheckinoutRows({
      header: parsed.header,
      rows: parsed.rows,
      map,
      lineNumbers: parsed.lineNumbers,
    });

    const invalid = [];
    const valid = [];
    for (let i = 0; i < converted.rows.length; i += 1) {
      const normalized = normalizeCheckinoutRow(converted.rows[i]);
      if (normalized.invalidReason) {
        invalid.push({ lineNumber: converted.lineNumbers[i], reason: normalized.invalidReason });
      } else {
        valid.push({ normalized, lineNumber: converted.lineNumbers[i] });
      }
    }

    // In-file duplicates are computed locally; the repository is never queried.
    const keyLines = new Map();
    for (const entry of valid) {
      const key = buildSourceEventKey(entry.normalized);
      if (!keyLines.has(key)) keyLines.set(key, []);
      keyLines.get(key).push(entry.lineNumber);
    }
    let inFileDuplicateCount = 0;
    const duplicateLineNumbers = [];
    for (const lines of keyLines.values()) {
      if (lines.length > 1) {
        inFileDuplicateCount += 1;
        duplicateLineNumbers.push(...lines.slice(1)); // repeats beyond the first occurrence
      }
    }
    duplicateLineNumbers.sort((a, b) => a - b);

    let windowFrom = null;
    let windowTo = null;
    for (const entry of valid) {
      const stamp = entry.normalized.checkTime;
      if (windowFrom === null || stamp < windowFrom) windowFrom = stamp;
      if (windowTo === null || stamp > windowTo) windowTo = stamp;
    }

    const skipped = converted.skipped;
    const report = {
      fileName: baseFileName,
      byteLength: bytes.length,
      inputSha256,
      parserVersion: CSV_PARSER_VERSION,
      header: parsed.header,
      columnMap: map,
      ignoredHeaders,
      rowCount: parsed.rows.length,
      acceptedCount: converted.rows.length,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, REPORT_LIST_CAP),
      skippedTruncated: skipped.length > REPORT_LIST_CAP,
      invalidCount: invalid.length,
      invalid: invalid.slice(0, REPORT_LIST_CAP),
      invalidTruncated: invalid.length > REPORT_LIST_CAP,
      inFileDuplicateCount,
      duplicateLineNumbers,
      windowFrom,
      windowTo,
    };

    return { report, rows: converted.rows };
  }

  async function inspectCsv({ text, buffer, fileName, columnMap = {} } = {}) {
    return analyze({ text, buffer, fileName, columnMap }).report;
  }

  async function ingestCsv({
    text,
    buffer,
    fileName,
    columnMap = {},
    sourceSystem,
    sourceReference,
    dryRun = true,
  } = {}) {
    const { report, rows } = analyze({ text, buffer, fileName, columnMap });

    if (dryRun) {
      return { dryRun: true, report };
    }

    // Dry run is the default. A real run will only ever touch the store AFTER the
    // structural checks above (and this count check) have passed.
    if (report.acceptedCount === 0) {
      throw new HttpError(400, 'CSV_NO_VALID_ROWS', 'No valid FaceScan rows were found in the file');
    }

    const batch = await ingestion.startBatch({
      sourceSystem,
      sourceType: 'checkinout',
      sourceReference: sourceReference ?? `${report.fileName}#${report.inputSha256.slice(0, 12)}`,
      fileName: report.fileName,
      inputSha256: report.inputSha256,
      parserVersion: report.parserVersion,
      // The mapping that was ACTUALLY used (with overrides resolved against the real header), not the raw
      // caller override: that is the whole point of the provenance column.
      columnMapJson: JSON.stringify(report.columnMap),
      windowFrom: report.windowFrom,
      windowTo: report.windowTo,
    });

    // Rows pass straight through: ingestCheckinoutBatch keeps validation, dedup and
    // idempotency as the single source of truth. A row that fails normalization is
    // counted as `failed` there and must NOT abort the file.
    const ingested = await ingestion.ingestCheckinoutBatch(batch.batchUid, rows, { sourceSystem });

    return { dryRun: false, report, batch: ingested.batch };
  }

  return { inspectCsv, ingestCsv };
}

module.exports = { createFacescanCsvIngestionService };
