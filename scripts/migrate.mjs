#!/usr/bin/env node
/**
 * Apply SQL migrations from database/migrations/ and optionally load dev seeds.
 *
 * Env (defaults match deploy/docker-compose.yml):
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *
 * Migrations are safe to run against a persistent database and are idempotent
 * (the ledger keys on the full filename).
 *
 * The dev fixture seed is destructive and opt-in only. `--seed` / `--seed-only`
 * are refused unless DEPLOY_ENV is on a small allowlist, NODE_ENV is not
 * production, ALLOW_FIXTURE_SEED=true, and the target host is disposable.
 * Any unknown DEPLOY_ENV fails closed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'database', 'migrations');
const seedFile = path.join(repoRoot, 'database', 'seeds', 'dev-fixtures.sql');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseArgs(argv) {
  return {
    seed: argv.includes('--seed'),
    seedOnly: argv.includes('--seed-only'),
    dryRun: argv.includes('--dry-run'),
  };
}

// Hosts that are known to be a disposable local/compose target.
const SEED_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'mariadb']);

// Allowlist, not a denylist: an unrecognised environment is treated as unsafe.
// NOTE: this guards a host name only. A 127.0.0.1 SSH tunnel to a real database
// is indistinguishable here, so this is a safety rail, never a security boundary.
const SEED_ALLOWED_DEPLOY_ENVS = new Set(['fixture', 'development', 'test']);
const SEED_ALLOWED_NODE_ENVS = new Set(['development', 'test', 'fixture']);

const SEED_DESTRUCTIVE_TABLES = [
  'daily_attendance',
  'monthly_summary',
  'employee_leave',
  'leave_balance',
  'employee_identifier',
  'employees',
];

/**
 * Guard for the destructive dev seed. Runs before any connection is opened.
 * Returns a list of reasons to refuse; empty means the seed may run.
 */
function seedGuardErrors(env, target) {
  const errors = [];
  const deployEnv = String(env.DEPLOY_ENV || '').trim().toLowerCase();
  if (!SEED_ALLOWED_DEPLOY_ENVS.has(deployEnv)) {
    errors.push(
      `DEPLOY_ENV must be one of ${[...SEED_ALLOWED_DEPLOY_ENVS].join(', ')}; `
      + `got ${deployEnv ? `"${deployEnv}"` : 'an unset value'}`,
    );
  }
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  if (!SEED_ALLOWED_NODE_ENVS.has(nodeEnv)) {
    errors.push(`NODE_ENV must be one of ${[...SEED_ALLOWED_NODE_ENVS].join(', ')}; got "${nodeEnv}"`);
  }
  if (String(env.ALLOW_FIXTURE_SEED || '').toLowerCase() !== 'true') {
    errors.push('ALLOW_FIXTURE_SEED=true is required to acknowledge the destructive seed');
  }
  if (!SEED_ALLOWED_HOSTS.has(target.host)) {
    if (String(env.ALLOW_REMOTE_FIXTURE_SEED || '').toLowerCase() !== 'true') {
      errors.push(
        `refusing to seed non-disposable host "${target.host}"; `
        + 'set ALLOW_REMOTE_FIXTURE_SEED=true only for a throw-away database',
      );
    }
  }
  return errors;
}

function printSeedWarning(target) {
  console.warn(
    `seed: DESTRUCTIVE - deleting and re-inserting synthetic fixtures in `
    + `database "${target.database}" on "${target.host}:${target.port}".`,
  );
  console.warn(`seed: tables cleared: ${SEED_DESTRUCTIVE_TABLES.join(', ')}`);
}

async function listMigrationFiles() {
  const entries = await fs.readdir(migrationsDir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

async function ensureSchemaMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedVersions(connection) {
  const [rows] = await connection.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
}

async function applyMigration(connection, version, sql) {
  await connection.beginTransaction();
  try {
    await connection.query(sql);
    await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function runSeed(connection) {
  const sql = await fs.readFile(seedFile, 'utf8');
  await connection.query(sql);
}

async function main() {
  const { seed, seedOnly, dryRun } = parseArgs(process.argv.slice(2));

  const config = {
    host: env('MYSQL_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_PORT', '3307')),
    user: env('MYSQL_USER', 'attendance'),
    password: env('MYSQL_PASSWORD', 'attendance'),
    database: env('MYSQL_DATABASE', 'attendance_v2'),
    multipleStatements: true,
  };

  // Guard before connecting: a misconfigured target must fail without touching it.
  if ((seed || seedOnly) && !dryRun) {
    const refusals = seedGuardErrors(process.env, config);
    if (refusals.length > 0) {
      for (const reason of refusals) console.error(`seed refused: ${reason}`);
      console.error('seed refused: no connection was opened and no data was changed.');
      process.exit(1);
    }
    printSeedWarning(config);
  }

  const files = await listMigrationFiles();
  if (files.length === 0) {
    console.error('No migration files in database/migrations/');
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run — migration files in order:');
    for (const file of files) console.log(`  ${file}`);
    if (seed || seedOnly) console.log('Would run seed:', path.relative(repoRoot, seedFile));
    return;
  }

  const connection = await mysql.createConnection(config);
  try {
    if (!seedOnly) {
      await ensureSchemaMigrationsTable(connection);
      const done = await appliedVersions(connection);

      for (const file of files) {
        if (done.has(file)) {
          console.log(`skip ${file}`);
          continue;
        }
        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
        console.log(`apply ${file}`);
        await applyMigration(connection, file, sql);
      }
    }

    if (seed || seedOnly) {
      console.log(`seed ${path.relative(repoRoot, seedFile)}`);
      await runSeed(connection);
    }

    console.log('done');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
