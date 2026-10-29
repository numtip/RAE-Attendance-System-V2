#!/usr/bin/env node
/**
 * N-6 backfill + duplicate detection — migration-safe, dry-run by default.
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration `029` adds `employee_identifier.national_id_subject_key`: the national-ID digest under a
 * DEDICATED, never-rotating index key, with a global UNIQUE index so that one person cannot exist twice
 * across key versions. A stored digest cannot be reversed, so the migration cannot fill that column itself —
 * it refuses to install the guard while any `national_id` row exists. This script is the operator's half:
 * take the source-of-truth IDs, compute the subject keys, and write them.
 *
 * WHAT IT REFUSES TO DO
 *   * run without `NATIONAL_ID_INDEX_KEY` (no default key, no unkeyed hash)
 *   * write anything unless `--apply` is given (dry-run is the default)
 *   * print or log a raw national ID, ever — only counts and employee codes are printed
 *
 * USAGE
 *   node scripts/national-id-subject-backfill.mjs --csv ids.csv               # plan only
 *   node scripts/national-id-subject-backfill.mjs --csv ids.csv --apply       # write
 *
 * CSV columns (header required, extra columns ignored): employee_uid,national_id
 * Env: NATIONAL_ID_INDEX_KEY (>= 32 bytes) plus the usual MYSQL_* connection variables.
 *
 * Exit: 0 = plan clean / applied · 2 = duplicates found (nothing written) · 1 = refused or failed.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The subject key: HMAC-SHA-256 of the canonical 13-digit ID under the non-rotating index key. */
export function subjectKeyFor(rawId, indexKey) {
  const canonical = String(rawId ?? '').replace(/\D/g, '');
  if (canonical.length !== 13) {
    const error = new Error('NATIONAL_ID_INVALID: a national ID must be exactly 13 digits');
    error.code = 'NATIONAL_ID_INVALID';
    throw error;
  }
  if (!indexKey || Buffer.byteLength(indexKey, 'utf8') < 32) {
    const error = new Error('INDEX_KEY_INVALID: NATIONAL_ID_INDEX_KEY must be at least 32 bytes');
    error.code = 'INDEX_KEY_INVALID';
    throw error;
  }
  return createHmac('sha256', indexKey).update(canonical, 'utf8').digest('hex');
}

/**
 * Groups rows by subject key and reports every person who maps to more than one employee.
 * This is the duplicate detection: it is the only way to see a cross-version duplicate, because the stored
 * digests differ by version and therefore cannot be compared to each other.
 */
export function findDuplicates(rows, indexKey) {
  const byKey = new Map();
  for (const row of rows) {
    const key = subjectKeyFor(row.nationalId, indexKey);
    const entry = byKey.get(key) ?? { subjectKey: key, employees: new Set() };
    entry.employees.add(row.employeeUid);
    byKey.set(key, entry);
  }
  const duplicates = [];
  const unique = [];
  for (const entry of byKey.values()) {
    if (entry.employees.size > 1) duplicates.push({ subjectKey: entry.subjectKey, employees: [...entry.employees] });
    else unique.push({ subjectKey: entry.subjectKey, employeeUid: [...entry.employees][0] });
  }
  return { duplicates, unique };
}

/** Minimal CSV reader: header-driven, quoted commas are not supported — IDs and UUIDs never contain one. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines[0].split(',').map((name) => name.trim().toLowerCase());
  const uidIndex = header.indexOf('employee_uid');
  const idIndex = header.indexOf('national_id');
  if (uidIndex < 0 || idIndex < 0) {
    const error = new Error('CSV_HEADER_INVALID: expected employee_uid,national_id');
    error.code = 'CSV_HEADER_INVALID';
    throw error;
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return { employeeUid: cells[uidIndex].trim(), nationalId: cells[idIndex].trim() };
  });
}

async function main(argv) {
  const args = argv.slice(2);
  const csvPath = args[args.indexOf('--csv') + 1];
  const apply = args.includes('--apply');
  if (!csvPath || csvPath.startsWith('--')) {
    console.error('refused: --csv <path> is required');
    return 1;
  }
  const indexKey = process.env.NATIONAL_ID_INDEX_KEY;
  if (!indexKey) {
    console.error('refused: NATIONAL_ID_INDEX_KEY is not configured (a subject key cannot be computed without it)');
    return 1;
  }

  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const { duplicates, unique } = findDuplicates(rows, indexKey);
  console.log(`rows=${rows.length} unique_people=${unique.length} duplicates=${duplicates.length}`);
  if (duplicates.length > 0) {
    // Employee codes only — never the ID, never the key, never the digest.
    for (const dup of duplicates) console.error(`DUPLICATE: ${dup.employees.join(' , ')} share one national ID`);
    console.error('refused: resolve these duplicates before backfilling; nothing was written');
    return 2;
  }
  if (!apply) {
    console.log('dry run: nothing written. Re-run with --apply to backfill national_id_subject_key.');
    return 0;
  }

  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'attendance',
    password: process.env.MYSQL_PASSWORD || 'attendance',
    database: process.env.MYSQL_DATABASE || 'attendance_v2',
  });
  try {
    let updated = 0;
    for (const row of unique) {
      const [result] = await connection.query(
        `UPDATE employee_identifier SET national_id_subject_key = ?
          WHERE employee_uid = ? AND id_type = 'national_id' AND national_id_subject_key IS NULL`,
        [row.subjectKey, row.employeeUid],
      );
      updated += result.affectedRows;
    }
    console.log(`applied: rows_updated=${updated} of planned=${unique.length}`);
    if (updated !== unique.length) {
      console.error(
        'warning: fewer rows updated than planned — a national_id row may be missing for a planned employee. '
        + 'Re-run the plan before tightening the column to NOT NULL.',
      );
      return 1;
    }
    return 0;
  } finally {
    await connection.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code)).catch((error) => {
    console.error(`${error.code || 'BACKFILL_FAILED'} ${error.message || ''}`.trim());
    process.exit(1);
  });
}
