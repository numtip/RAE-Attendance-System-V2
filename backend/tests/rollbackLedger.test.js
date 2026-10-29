const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Same resolution the other suite-level tests use (no __dirname in this eslint config).
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');
const ROLLBACKS_DIR = path.join(backendRoot, '..', 'database', 'rollbacks');
const MIGRATIONS_DIR = path.join(backendRoot, '..', 'database', 'migrations');

function rollbackFiles() {
  return fs.readdirSync(ROLLBACKS_DIR).filter((name) => name.endsWith('.down.sql')).sort();
}

test('every rollback clears its own ledger row', () => {
  // The runner keys the ledger on the filename (scripts/migrate.mjs:9) and skips an applied file
  // (:174). A rollback that does not delete the ledger row therefore leaves the schema partially
  // rolled back and a plain `npm run db:migrate` will NOT restore it — the operator has to clear
  // the row by hand. Verified on a disposable MariaDB: 9 of 10 rollbacks had this defect before
  // 2026-10-29, and one of them (026) also aborted on a second run with ERROR 1091.
  const missing = [];
  for (const file of rollbackFiles()) {
    const migration = file.slice(0, -'.down.sql'.length) + '.sql';
    const sql = fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf8');
    const expected = `DELETE FROM schema_migrations WHERE version = '${migration}'`;
    if (!sql.includes(expected)) missing.push(file);
  }
  assert.deepEqual(missing, [], `these rollbacks do not clear their ledger row: ${missing.join(', ')}`);
});

test('every rollback has a migration to roll back', () => {
  const migrations = new Set(fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')));
  const orphans = rollbackFiles().filter((file) => {
    const migration = file.slice(0, -'.down.sql'.length) + '.sql';
    return !migrations.has(migration);
  });
  // A rollback whose up-file was renamed or removed is dead code that looks live.
  assert.deepEqual(orphans, [], `these rollbacks have no matching migration: ${orphans.join(', ')}`);
});

test('the SSO attempt-store rollback drops the table it created', () => {
  const sql = fs.readFileSync(path.join(ROLLBACKS_DIR, '028_sso_login_attempt.down.sql'), 'utf8');
  assert.match(sql, /DROP TABLE IF EXISTS sso_login_attempt/);
  assert.match(sql, /DELETE FROM schema_migrations WHERE version = '028_sso_login_attempt\.sql'/);
});

test('the 026 rollback is guarded, because a second run used to abort', () => {
  // ERROR 1091 Can't DROP INDEX ... on a retry left the table half rolled back. Every DROP is now
  // behind an information_schema check.
  const sql = fs.readFileSync(path.join(ROLLBACKS_DIR, '026_refresh_token_family.down.sql'), 'utf8');
  assert.match(sql, /information_schema\.STATISTICS/);
  assert.match(sql, /information_schema\.COLUMNS/);
  assert.match(sql, /DELETE FROM refresh_tokens WHERE token IS NULL/, 'the session loss must stay visible');
});
