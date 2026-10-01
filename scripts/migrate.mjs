#!/usr/bin/env node
/**
 * Apply SQL migrations from database/migrations/ and optionally load dev seeds.
 *
 * Env (defaults match deploy/docker-compose.yml):
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
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
    dryRun: argv.includes('--dry-run'),
  };
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
  const { seed, dryRun } = parseArgs(process.argv.slice(2));

  const config = {
    host: env('MYSQL_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_PORT', '3307')),
    user: env('MYSQL_USER', 'attendance'),
    password: env('MYSQL_PASSWORD', 'attendance'),
    database: env('MYSQL_DATABASE', 'attendance_v2'),
    multipleStatements: true,
  };

  const files = await listMigrationFiles();
  if (files.length === 0) {
    console.error('No migration files in database/migrations/');
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run — pending migrations:');
    for (const file of files) console.log(`  ${file}`);
    if (seed) console.log('Would run seed:', path.relative(repoRoot, seedFile));
    return;
  }

  const connection = await mysql.createConnection(config);
  try {
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

    if (seed) {
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
