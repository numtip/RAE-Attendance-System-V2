/**
 * Guardrails for `database/preflight/`.
 *
 * `scripts/secret-scan.mjs` blocks every `.sql` file outside `database/migrations|seeds|rollbacks`, and
 * `.gitignore` ignores the rest. Adding `database/preflight/` to both is a real relaxation of that control, so
 * it is only acceptable if the directory is guaranteed to contain read-only scripts. This test enforces that
 * guarantee mechanically, so a future preflight cannot quietly become a migration.
 *
 * The rule is the same one the 027 proposal relies on: a preflight may SELECT, SHOW and DESCRIBE. It may not
 * write, define objects, or execute dynamic SQL.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(
  path.dirname(require.resolve('../../scripts/secret-scan.mjs')),
  '..',
);
const PREFLIGHT_DIR = path.join(REPO_ROOT, 'database', 'preflight');

function preflightFiles() {
  if (!fs.existsSync(PREFLIGHT_DIR)) return [];
  return fs.readdirSync(PREFLIGHT_DIR).filter((name) => name.toLowerCase().endsWith('.sql')).sort();
}

/** Strips `--` line comments so a commented-out `ALTER` cannot trip the guard (or hide a real one). */
function stripComments(sql) {
  return sql
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

test('every preflight script is read-only', () => {
  const files = preflightFiles();
  assert.ok(files.length > 0, 'expected at least one preflight script — the directory is part of this change');

  const forbidden = [
    ['INSERT', /\bINSERT\s+(INTO|IGNORE)\b/i],
    ['UPDATE', /\bUPDATE\s+\w+\s+SET\b/i],
    ['DELETE', /\bDELETE\s+FROM\b/i],
    ['REPLACE', /\bREPLACE\s+INTO\b/i],
    ['ALTER', /\bALTER\s+TABLE\b/i],
    ['DROP', /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW|TRIGGER|USER)\b/i],
    ['CREATE', /\bCREATE\s+(TABLE|DATABASE|INDEX|VIEW|TRIGGER|USER|TEMPORARY)\b/i],
    ['TRUNCATE', /\bTRUNCATE\s+TABLE\b/i],
    ['GRANT/REVOKE', /\b(GRANT|REVOKE)\b/i],
    ['dynamic SQL', /\b(PREPARE|EXECUTE|DEALLOCATE\s+PREPARE)\b/i],
  ];

  for (const name of files) {
    const sql = stripComments(fs.readFileSync(path.join(PREFLIGHT_DIR, name), 'utf8'));
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(sql), false, `database/preflight/${name} must be read-only but contains ${label}`);
    }
  }
});

test('preflight filenames follow the numbered convention the secret scanner allows', () => {
  // scripts/secret-scan.mjs permits `database/preflight/NNN_name.sql` only. A file that does not match would
  // be blocked in CI while sitting in the tree, which is the confusing half-state to avoid.
  const allowed = /^\d{3}_[a-z0-9_]+\.sql$/;
  for (const name of preflightFiles()) {
    assert.match(name, allowed, `database/preflight/${name} does not match the allowed NNN_name.sql pattern`);
  }
});

test('the scanner and .gitignore actually permit the preflight directory this branch ships', () => {
  // Read the real rules rather than re-implementing them, so the three cannot drift apart.
  const scanner = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'secret-scan.mjs'), 'utf8');
  assert.ok(scanner.includes('preflight'), 'scripts/secret-scan.mjs must explicitly permit database/preflight/*.sql');
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^!database\/preflight\/\*\.sql$/m, '.gitignore must un-ignore database/preflight/*.sql');
});
