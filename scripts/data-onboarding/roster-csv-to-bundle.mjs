#!/usr/bin/env node
/**
 * Owner roster CSV -> onboarding source bundle (employees only).
 *
 *   node scripts/data-onboarding/roster-csv-to-bundle.mjs <roster.csv> \
 *     --department "<ชื่อหน่วยงาน>" [--out database/local/roster-bundle.json] [--reuse-from <bundle.json>]
 *
 * Columns are the ones `normalizeRosterRow` documents: `ID HIP`, `name`, `c_name`, `email`,
 * `employee type`, and a national-ID column that is read only to prove it exists and then dropped —
 * `employee_identifier` rows with `id_type = national_id` are rejected at this layer and the value
 * never enters the bundle.
 *
 * `--department` is required: the roster carries an employment type, not an org unit, and inventing a
 * department would be a silent data decision. `employees.department` is NOT NULL, so the caller states it.
 *
 * shortcut: an employee_uid is generated once per employee_id and frozen in the bundle; re-running
 * without --reuse-from mints new UIDs. Keep the bundle as the record of what was imported.
 *
 * stdout carries counts and a hash only — never a name, email or national ID.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeCsvBuffer, parseCsv } from './csvText.mjs';
import { normalizeRosterRow } from './rosterReconciliation.mjs';
import { EMPLOYEE_TYPES } from './lib.mjs';

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const file = process.argv[2];
const department = arg('department');
if (!file) { console.error('usage: roster-csv-to-bundle.mjs <roster.csv> --department "<unit>" [--out <file>] [--reuse-from <file>]'); process.exit(2); }
if (!department) { console.error('REFUSED: --department is required (the roster has no org unit column)'); process.exit(2); }

const text = decodeCsvBuffer(await readFile(file));
const rows = parseCsv(text);
if (rows.length === 0) { console.error('REFUSED: no rows'); process.exit(3); }
// parseCsv hands back raw rows; the header is the first one and every value stays a string.
const [headerRow, ...dataRows] = rows;
const headers = headerRow.map((cell) => cell.trim());
const records = dataRows.map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index] ?? ''])));
const required = ['ID HIP', 'name', 'c_name', 'email', 'employee type'];
const missing = required.filter((h) => !headers.includes(h));
if (missing.length) { console.error(`REFUSED: roster is missing columns: ${missing.join(', ')}`); process.exit(3); }

const reuseFrom = arg('reuse-from');
const reused = new Map();
if (reuseFrom) {
  const prior = JSON.parse(await readFile(reuseFrom, 'utf8'));
  for (const employee of prior.employees ?? []) reused.set(employee.employee_id, employee.employee_uid);
}

const errors = [];
const employees = [];
const seenIds = new Set();
const seenEmails = new Set();

records.forEach((record, index) => {
  const row = normalizeRosterRow(record, index + 2);
  if (!row.code) errors.push(`row ${row.rowNumber}: missing ID HIP`);
  if (!row.nameTh || !row.cNameTh) errors.push(`row ${row.rowNumber}: missing name`);
  if (!EMAIL_SHAPE.test(row.email)) errors.push(`row ${row.rowNumber}: email is not a plain address`);
  if (seenIds.has(row.code)) errors.push(`row ${row.rowNumber}: duplicate ID HIP`);
  if (row.email && seenEmails.has(row.email)) errors.push(`row ${row.rowNumber}: duplicate email`);
  if (!EMPLOYEE_TYPES.has(row.employeeType)) errors.push(`row ${row.rowNumber}: employee type "${row.employeeType}" is not one of ${[...EMPLOYEE_TYPES].join('/')}`);
  seenIds.add(row.code);
  seenEmails.add(row.email);
  employees.push({
    employee_uid: reused.get(row.code) ?? randomUUID(),
    employee_id: row.code,
    first_name_th: row.nameTh,
    last_name_th: row.cNameTh,
    email: row.email,
    department,
    employee_type: row.employeeType,
    status: 'active',
    role: 'user',
  });
});

if (errors.length) {
  console.error(`REFUSED: ${errors.length} problem(s)`);
  for (const message of errors.slice(0, 20)) console.error(`  ${message}`);
  process.exit(4);
}

// `employees.role` is the legacy enum on the table ('admin' | 'manager' | 'user'), not the access
// role set used by authorization_grants. Everyone arrives as 'user'; elevation is a separate grant.
const EMPLOYEE_ROLES = new Set(['admin', 'manager', 'user']);
for (const employee of employees) {
  if (!EMPLOYEE_ROLES.has(employee.role)) {
    console.error('REFUSED: role must be one of admin/manager/user');
    process.exit(4);
  }
}

const bundle = {
  manifest: {
    label: 'owner roster 2027',
    kind: 'employees',
    authority: 'owner-supplied roster CSV',
    note: 'national ID dropped at conversion; no credentials, no sessions, no attendance history',
  },
  employees,
};

const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
const hash = createHash('sha256').update(serialized).digest('hex');
const out = arg('out');
if (out) {
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(resolve(out), serialized);
}

console.log(JSON.stringify({
  employees: employees.length,
  reusedUids: employees.filter((employee) => [...reused.values()].includes(employee.employee_uid)).length,
  department,
  nationalIdIncluded: false,
  bundleSha256: hash,
  wrote: out ?? null,
}, null, 2));
if (!out) console.error('note: no --out given, so the bundle was printed now and never stored; pass --out to keep it');
if (!out) process.stdout.write(serialized);
