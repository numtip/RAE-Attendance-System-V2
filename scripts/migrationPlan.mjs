/**
 * Pure migration-planning helpers for scripts/migrate.mjs.
 *
 * Kept in its own module, with no database dependency, so the ledger logic can
 * be unit-tested without installing mysql2 or starting a server. The runner
 * keys `schema_migrations` on the full filename and has no checksum, so "what
 * is pending" is exactly "files on disk minus filenames in the ledger".
 */

import fs from 'node:fs/promises';

export function parseArgs(argv) {
  return {
    seed: argv.includes('--seed'),
    dryRun: argv.includes('--dry-run'),
  };
}

export async function listMigrationFiles(migrationsDir) {
  const entries = await fs.readdir(migrationsDir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Split the on-disk files against the recorded ledger.
 *
 * `applied` is a Set of version strings exactly as `schema_migrations` stores
 * them (full filename, case-sensitive). Skip is an exact string match, the same
 * rule the apply path uses.
 */
export function planMigrations(files, applied) {
  return {
    pending: files.filter((name) => !applied.has(name)),
    skipped: files.filter((name) => applied.has(name)),
  };
}

/**
 * Lines a `--dry-run` prints. Reports what the ledger actually holds instead of
 * listing every file as if it were pending, which is the behaviour that made
 * `--dry-run` look like schema validation when it was not.
 */
export function describeDryRun({ pending, skipped, total, ledgerLabel }) {
  const lines = [
    `Dry run — ledger ${ledgerLabel} records ${skipped.length} of ${total} migration files.`,
  ];
  if (pending.length === 0) {
    lines.push('  nothing pending');
  } else {
    lines.push(`  ${pending.length} pending, in the order a stock run would attempt them (it stops at the first error):`);
    for (const name of pending) lines.push(`    apply ${name}`);
  }
  lines.push(`  ${skipped.length} already applied (skipped)`);
  return lines;
}
