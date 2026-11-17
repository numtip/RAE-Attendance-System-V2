#!/usr/bin/env node
/**
 * Apply an onboarding bundle's employees to a database — the step the dry-run tools stop short of.
 *
 *   MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
 *     node scripts/data-onboarding/apply-import.mjs <bundle.json> --dry-run
 *     ... --confirm-import
 *
 * Only `employees` is written. No credentials, sessions, attendance history, national IDs or identity
 * links: SSO links are created by hand and approved by a second reviewer, never by an import.
 *
 * Idempotent: the employee_uid travels in the bundle and is the key, so a second run updates the same
 * rows instead of minting new people. Prints counts only, never a name or email.
 */
import { readFile } from 'node:fs/promises';
import { validateSource, dryRun, EMPLOYEE_TYPES, EMPLOYEE_STATUSES } from './lib.mjs';

const file = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const CONFIRM = process.argv.includes('--confirm-import');
if (!file) { console.error('usage: apply-import.mjs <bundle.json> [--dry-run|--confirm-import]'); process.exit(2); }
if (!DRY && !CONFIRM) { console.error('REFUSED: pass --dry-run to preview or --confirm-import to write'); process.exit(2); }

const text = await readFile(file, 'utf8');
const bundle = JSON.parse(text);
const validation = validateSource(bundle);
if (!validation.ok) {
  console.error(`REFUSED: bundle failed validation (${validation.errors.length} problem(s))`);
  for (const error of validation.errors.slice(0, 20)) console.error(`  ${error}`);
  process.exit(3);
}

const plan = dryRun(bundle, { sourceText: text });
const employees = bundle.employees ?? [];
for (const employee of employees) {
  if (!EMPLOYEE_TYPES.has(employee.employee_type)) { console.error('REFUSED: unknown employee_type'); process.exit(3); }
  if (!EMPLOYEE_STATUSES.has(employee.status)) { console.error('REFUSED: unknown status'); process.exit(3); }
}

console.log(JSON.stringify({
  mode: DRY ? 'dry-run' : 'import',
  employees: employees.length,
  plan: Object.fromEntries(Object.entries(plan.tables ?? {}).map(([table, entry]) => [table, entry.rows])),
  identityLinksTouched: 0,
  credentialsIncluded: false,
}, null, 2));
if (DRY) process.exit(0);

// Loaded only on the write path, so --dry-run works on a checkout without dependencies installed.
const { default: mysql } = await import('mysql2/promise');
const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'attendance',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'attendance_v2',
});
let inserted = 0;
try {
  for (const employee of employees) {
    const [result] = await connection.query(
      `INSERT INTO employees
         (employee_uid, employee_id, first_name_th, last_name_th, email, department,
          employee_type, status, role, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id), first_name_th = VALUES(first_name_th),
         last_name_th = VALUES(last_name_th), email = VALUES(email),
         department = VALUES(department), employee_type = VALUES(employee_type),
         status = VALUES(status), role = VALUES(role), updated_at = NOW()`,
      [
        employee.employee_uid, employee.employee_id, employee.first_name_th, employee.last_name_th,
        employee.email, employee.department, employee.employee_type, employee.status, employee.role,
      ],
    );
    inserted += result.affectedRows;
  }
  const [[counted]] = await connection.query('SELECT COUNT(*) AS total FROM employees');
  console.log(JSON.stringify({ imported: employees.length, affectedRows: inserted, employeesInDatabase: counted.total }, null, 2));
} finally {
  await connection.end();
}
