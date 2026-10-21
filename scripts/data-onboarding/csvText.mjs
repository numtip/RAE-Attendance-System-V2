/**
 * Minimal, dependency-free CSV text handling for the data-onboarding scripts.
 *
 * Why this exists instead of an import: the roster reconciliation must run on any branch, and the richer
 * ID-card CSV helper (`map-idcard-identity-kinds.mjs`) is not on `main`. Duplicating ~40 lines here keeps the
 * reconciliation reviewable on its own; when the ID-card tooling lands, it should adopt this module rather
 * than keep two parsers (recorded as a follow-up in `docs/EMPLOYEE_MASTER_F4_IDENTITY_POLICY.md`).
 *
 * Scope: UTF-8 with or without a BOM, RFC-4180 quoting with doubled quotes, embedded commas and CRLF/LF.
 */

/**
 * Decodes a buffer: strips a real UTF-8 BOM, prefers UTF-8, and falls back to single-byte for legacy files.
 * A lone U+FFFD means the bytes were not UTF-8 (e.g. cp874); digits stay ASCII in both encodings.
 */
export function decodeCsvBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
}

/** RFC-4180 reader. Returns every non-blank row as an array of raw (untrimmed) cell strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
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
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/**
 * Reads a CSV file and returns `{ header, records }`, where each record is keyed by the trimmed header and
 * values are trimmed strings. Quoted cells are unwrapped by `parseCsv`; no other interpretation is applied.
 */
export async function readCsvRecords(path) {
  const { readFile } = await import('node:fs/promises');
  const rows = parseCsv(decodeCsvBuffer(await readFile(path)));
  if (rows.length === 0) return { header: [], records: [] };
  const [headerRow, ...dataRows] = rows;
  const header = headerRow.map((cell) => cell.trim());
  const records = dataRows.map((cells) => Object.fromEntries(
    header.map((key, index) => [key, (cells[index] ?? '').trim()]),
  ));
  return { header, records };
}
