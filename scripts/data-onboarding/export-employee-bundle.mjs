/**
 * READ-ONLY export of employees + employee_identifier for local reconciliation.
 * Writes gitignored bundle under database/local/ (no national_id in stdout).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createPool } from 'mysql2/promise';
import path from 'node:path';

const outDir = path.join('database', 'local');
const outFile = path.join(outDir, 'employee-reconciliation-bundle.json');

function env(name) {
  return process.env[name] || '';
}

async function main() {
  const host = env('DB_HOST') || env('MYSQL_HOST');
  const name = env('DB_NAME') || env('MYSQL_DATABASE');
  const user = env('DB_USER') || env('MYSQL_USER');
  const password = env('DB_PASSWORD') || env('MYSQL_PASSWORD');
  const port = Number(env('DB_PORT') || env('MYSQL_PORT') || 3306);

  if (!host || !name || !user) {
    console.log(JSON.stringify({
      ok: false,
      code: 'DB_NOT_CONFIGURED',
      message: 'Set DB connection fields (do not commit). No key is needed: national_id rows already hold HMAC lookups.',
    }));
    process.exit(2);
  }

  const pool = createPool({
    host,
    port,
    database: name,
    user,
    password,
    connectionLimit: 2,
  });

  try {
    const [employees] = await pool.query(
      `SELECT employee_uid, status,
              locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP() AS is_locked
       FROM employees`,
    );
    const [identifiers] = await pool.query(
      `SELECT employee_uid, id_type, id_value, lookup_key_version, source_system, status
       FROM employee_identifier
       WHERE status = 'active'
         AND id_type IN ('national_id', 'facescan_id')`,
    );

    const bundle = {
      exportedAt: new Date().toISOString(),
      employees: employees.map((row) => ({
        employee_uid: row.employee_uid,
        status: row.status,
        is_locked: Boolean(row.is_locked),
      })),
      // Contract: national_id rows hold only an HMAC lookup (+ key version); facescan_id is a plain id_value.
      // A non-HMAC national_id value means legacy plaintext: refuse to export (and never echo it).
      employee_identifier: identifiers.map((row) => {
        if (row.id_type === 'national_id') {
          if (!/^[0-9a-f]{64}$/.test(String(row.id_value))) {
            throw new Error('PLAINTEXT_NATIONAL_ID_IN_DATABASE: run preflight/reindex before exporting');
          }
          return {
            employee_uid: row.employee_uid,
            id_type: row.id_type,
            lookup_hmac: row.id_value,
            lookup_key_version: row.lookup_key_version,
            source_system: row.source_system,
            status: row.status,
          };
        }
        return {
          employee_uid: row.employee_uid,
          id_type: row.id_type,
          id_value: row.id_value,
          source_system: row.source_system,
          status: row.status,
        };
      }),
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(bundle), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      path: outFile,
      employees: bundle.employees.length,
      identifiers: bundle.employee_identifier.length,
      nationalIdRows: bundle.employee_identifier.filter((r) => r.id_type === 'national_id').length,
      facescanRows: bundle.employee_identifier.filter((r) => r.id_type === 'facescan_id').length,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, code: 'EXPORT_FAILED', message: err.message }));
  process.exit(1);
});
