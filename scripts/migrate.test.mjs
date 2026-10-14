/**
 * Unit tests for the migration ledger logic in scripts/migrationPlan.mjs.
 *
 * No database and no mysql2 are needed: these cover the "what is pending"
 * decision and the `--dry-run` wording, which is where a wrong answer is
 * expensive. The production-shaped case below is the one that matters: a
 * stock run against that ledger would attempt the file that conflicts with the
 * live schema.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeDryRun,
  listMigrationFiles,
  parseArgs,
  planMigrations,
} from './migrationPlan.mjs';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'database',
  'migrations',
);

// Exactly what the production-shaped `schema_migrations` holds
// (docs/SSO_SCHEMA_RECONCILIATION.md):
// `001`-`010` plus `013_personnel_identifier.sql`.
const productionShapedLedger = new Set([
  '001_schema_migrations.sql',
  '002_employees.sql',
  '003_employee_identifier.sql',
  '004_daily_attendance.sql',
  '005_monthly_summary.sql',
  '006_employee_leave.sql',
  '007_leave_balance.sql',
  '008_refresh_tokens.sql',
  '009_auth_logs.sql',
  '010_system_logs.sql',
  '013_personnel_identifier.sql',
]);

test('parseArgs: recognises --dry-run and --seed, defaults both off', () => {
  assert.deepEqual(parseArgs([]), { seed: false, dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { seed: false, dryRun: true });
  assert.deepEqual(parseArgs(['--seed']), { seed: true, dryRun: false });
  assert.deepEqual(parseArgs(['--seed', '--dry-run']), { seed: true, dryRun: true });
});

test('planMigrations: an empty ledger marks every file pending', async () => {
  const files = await listMigrationFiles(migrationsDir);
  const { pending, skipped } = planMigrations(files, new Set());
  assert.deepEqual(pending, files);
  assert.deepEqual(skipped, []);
});

test('planMigrations: a fully applied ledger leaves nothing pending', async () => {
  const files = await listMigrationFiles(migrationsDir);
  const { pending, skipped } = planMigrations(files, new Set(files));
  assert.deepEqual(pending, []);
  assert.deepEqual(skipped, files);
});

test('planMigrations: skip is an exact filename match, not a prefix or number match', () => {
  const files = [
    '013_employee_identifier_foundation.sql',
    '013_personnel_identifier.sql',
    '013_personnel_identifier.sql.bak',
  ];
  const { pending } = planMigrations(files, new Set(['013_personnel_identifier.sql']));
  // The foundation file sorts BEFORE the recorded one ("e" < "p"), which is why
  // the runner reaches it first even though a `013_` filename is already logged.
  assert.deepEqual(pending, [
    '013_employee_identifier_foundation.sql',
    '013_personnel_identifier.sql.bak',
  ]);
});

test('production-shaped ledger: the run would attempt the conflicting 013 file', async () => {
  const files = await listMigrationFiles(migrationsDir);
  const { pending, skipped } = planMigrations(files, productionShapedLedger);

  assert.equal(skipped.length, productionShapedLedger.size);
  assert.deepEqual(skipped, files.filter((name) => productionShapedLedger.has(name)));

  // Everything not recorded is attempted, and the order is lexicographic.
  assert.deepEqual(pending, files.filter((name) => !productionShapedLedger.has(name)));
  assert.deepEqual(pending, [...pending].sort());

  // The hazard the audit recorded: this file conflicts with the live unique key
  // and enum order, and it sorts before the recorded 013 filename.
  assert.ok(pending.includes('013_employee_identifier_foundation.sql'));
  assert.ok(!pending.includes('013_personnel_identifier.sql'));
  assert.ok(pending.indexOf('013_employee_identifier_foundation.sql')
    < files.indexOf('013_personnel_identifier.sql'));

  // Both 015 files are independent versions and must both be attempted.
  assert.ok(pending.includes('015_employee_identifier_secure_lookup.sql'));
  assert.ok(pending.includes('015_facescan_hip_ingestion.sql'));

  // The SSO tables sit behind the conflicting file, so a stock run never
  // reaches them on this database.
  assert.ok(pending.includes('018_sso_consumed_code.sql'));
  assert.ok(pending.includes('019_sso_shared_claim.sql'));
  assert.ok(pending.indexOf('013_employee_identifier_foundation.sql')
    < pending.indexOf('018_sso_consumed_code.sql'));
});

test('describeDryRun: reports the ledger instead of listing everything as pending', () => {
  const pending = ['013_employee_identifier_foundation.sql', '017_identifier_namespace_claim.sql'];
  const skipped = ['001_schema_migrations.sql'];
  const lines = describeDryRun({
    pending,
    skipped,
    total: 3,
    ledgerLabel: 'attendance_v2@127.0.0.1:3307',
  });

  assert.equal(lines[0], 'Dry run — ledger attendance_v2@127.0.0.1:3307 records 1 of 3 migration files.');
  assert.ok(lines.some((line) => line.includes('2 pending')));
  assert.ok(lines.includes('    apply 013_employee_identifier_foundation.sql'));
  assert.ok(lines.includes('    apply 017_identifier_namespace_claim.sql'));
  // A recorded file must never appear as "apply".
  assert.ok(!lines.some((line) => line.includes('apply 001_schema_migrations.sql')));
});

test('describeDryRun: says nothing pending when the ledger is complete', () => {
  const lines = describeDryRun({
    pending: [],
    skipped: ['001_schema_migrations.sql', '002_employees.sql'],
    total: 2,
    ledgerLabel: 'attendance_v2@127.0.0.1:3307',
  });
  assert.ok(lines.some((line) => line.includes('nothing pending')));
  assert.ok(!lines.some((line) => line.includes('apply ')));
});
