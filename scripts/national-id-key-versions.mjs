#!/usr/bin/env node
/**
 * N-2 — which key versions do the stored national-ID digests actually use?
 *
 * Dropping a key version orphans every row written under it: those employees silently stop being
 * resolvable, and nothing in the application can enumerate them (`planReindex()` has no caller).
 * This is that enumeration, and it is READ-ONLY: one SELECT, no writes, no migrations.
 *
 * Exit codes: 0 = every stored version is still accepted; 2 = at least one version is orphaned;
 * 1 = could not run (no key configured, no database, bad query).
 *
 * Env: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE (same as scripts/migrate.mjs)
 *      NATIONAL_ID_HMAC_KEYS (same parsing as the application — one source of truth).
 *
 * Usage: node scripts/national-id-key-versions.mjs
 */
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { protectorFromEnv } = require('../backend/src/security/nationalIdContract.js');

/**
 * Classifies the stored version counts against the versions the application still accepts.
 * Pure, so the test can call it without a database.
 *
 * A row with a NULL version is reported, not ignored: the CHECK constraint requires a version for a
 * national_id row, so a NULL means the constraint was bypassed and the row is unqueryable.
 */
export function classifyKeyVersions(storedRows, acceptVersions) {
  const accepted = new Set(acceptVersions);
  const rows = storedRows.map((row) => {
    const version = row.lookup_key_version == null ? null : Number(row.lookup_key_version);
    return {
      version,
      // `row_count` is the SQL alias; `rows` is accepted too so a caller passing a plain object
      // cannot silently produce NaN — that mismatch is exactly how this script's unit test passed while
      // the query failed on a real server.
      rows: Number(row.row_count ?? row.rows),
      status: version != null && accepted.has(version) ? 'accepted' : 'ORPHANED',
    };
  });
  return {
    rows,
    orphaned: rows.filter((row) => row.status === 'ORPHANED'),
    ok: rows.every((row) => row.status === 'accepted'),
  };
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function main() {
  const protector = protectorFromEnv(process.env);
  const connection = await mysql.createConnection({
    host: env('MYSQL_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_PORT', '3306')),
    user: env('MYSQL_USER', 'attendance'),
    password: env('MYSQL_PASSWORD', 'attendance'),
    database: env('MYSQL_DATABASE', 'attendance_v2'),
  });
  try {
    const [stored] = await connection.query(
      // `rows` is a reserved word in MariaDB; the alias is explicit and quoted-safe.
      `SELECT lookup_key_version, COUNT(*) AS row_count
         FROM employee_identifier
        WHERE id_type = 'national_id'
        GROUP BY lookup_key_version
        ORDER BY lookup_key_version`,
    );
    const result = classifyKeyVersions(stored, protector.acceptVersions);
    console.log(`write version: ${protector.writeVersion} · accepted: ${protector.acceptVersions.join(', ')}`);
    if (result.rows.length === 0) {
      console.log('no national-ID digests are stored');
      return 0;
    }
    for (const row of result.rows) {
      console.log(`  version ${row.version ?? 'NULL'}: ${row.rows} row(s) ${row.status}`);
    }
    if (!result.ok) {
      console.error(
        `ORPHANED: ${result.orphaned.reduce((sum, row) => sum + row.rows, 0)} digest(s) use a version this `
        + 'process does not accept; those employees cannot be resolved. Do not drop a key version while this '
        + 'reports ORPHANED — reindex them to the write version first.',
      );
      return 2;
    }
    return 0;
  } finally {
    await connection.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`${error.code || 'KEY_VERSION_AUDIT_FAILED'} ${error.message || ''}`.trim());
    process.exit(1);
  });
}
