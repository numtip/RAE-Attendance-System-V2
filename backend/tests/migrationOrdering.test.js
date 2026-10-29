const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Same resolution the other suite-level tests use (no __dirname in this eslint config).
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');
const MIGRATIONS_DIR = path.join(backendRoot, '..', 'database', 'migrations');

// The runner applies migrations in filename sort order (scripts/migrate.mjs:99) and the ledger keys
// on the filename (scripts/migrate.mjs:9). Two files share the numeric prefix 015, so the applied
// order is decided by the words after the number. That order is load-bearing, not cosmetic; this
// test exists because an attempt to "fix" the duplicate number broke the chain (CI run 40846057083:
// 020 altered employee_identifier_access_audit before the file that creates it had run).
function sortedMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
}

function indexOf(files, prefix) {
  const index = files.findIndex((name) => name.startsWith(prefix));
  assert.notEqual(index, -1, `migration ${prefix} must exist`);
  return index;
}

test('the two 015 files exist, and their order is the only order that works', () => {
  const files = sortedMigrations();
  assert.ok(files.includes('015_employee_identifier_secure_lookup.sql'));
  assert.ok(files.includes('015_facescan_hip_ingestion.sql'));
  // 'employee...' sorts before 'facescan...', and nothing else in the chain may slip between them.
  assert.equal(
    indexOf(files, '015_facescan_hip_ingestion') - indexOf(files, '015_employee_identifier_secure_lookup'),
    1,
  );
});

test('the secure-lookup migration runs before everything that depends on it', () => {
  const files = sortedMigrations();
  const secureLookup = indexOf(files, '015_employee_identifier_secure_lookup');
  // 020 alters employee_identifier_access_audit, which only the secure-lookup file creates.
  assert.ok(
    secureLookup < indexOf(files, '020_employee_assignment_effective_dating'),
    '015_employee_identifier_secure_lookup must run before 020, which alters the audit table it creates',
  );
});

test('the facescan migration runs before the tables its dependents reference', () => {
  const files = sortedMigrations();
  const facescan = indexOf(files, '015_facescan_hip_ingestion');
  // 016 declares foreign keys to staging_facescan_raw and facescan_import_batches, created here.
  assert.ok(
    facescan < indexOf(files, '016_attendance_events'),
    '015_facescan_hip_ingestion must run before 016, whose foreign keys reference its tables',
  );
  assert.ok(
    facescan < indexOf(files, '021_facescan_ingestion_provenance'),
    '015_facescan_hip_ingestion must run before 021, which alters facescan_import_batches',
  );
});

test('reserved numbers stay unused', () => {
  const files = sortedMigrations();
  // Documented in 025_revoked_access_tokens.sql and asserted against a live ledger in
  // securitySlice.mariadb.integration.test.js.
  assert.equal(files.some((name) => name.startsWith('018_')), false);
  assert.equal(files.some((name) => name.startsWith('019_')), false);
});
