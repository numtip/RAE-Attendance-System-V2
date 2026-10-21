/**
 * Keeps the SQL shape constraint in step with the JavaScript rule.
 *
 * Two places now encode "what a version-4 UUID is": `domain/employeeUidAllocation.js` (the allocation policy)
 * and `database/proposals/027_…up.sql` (the proposed CHECK). If one drifts, the database would accept a UID the
 * code refuses to mint — or the reverse — and the failure would be invisible until an import.
 *
 * This is a parity test, not an engine test: it proves the two regexes agree on a sample set. It does NOT prove
 * MariaDB's REGEXP behaves like JavaScript's, which is why the proposal ships a preflight that probes the engine
 * itself before the ALTER.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { isUuidV4 } = require('../src/domain/employeeUidAllocation');

const REPO_ROOT = path.join(
  path.dirname(require.resolve('../src/domain/employeeUidAllocation')),
  '..', '..', '..',
);
const UP_SQL = path.join(REPO_ROOT, 'database', 'proposals', '027_employee_uid_uuid_v4.up.sql');
const DOWN_SQL = path.join(REPO_ROOT, 'database', 'proposals', '027_employee_uid_uuid_v4.down.sql');
const PREFLIGHT_SQL = path.join(REPO_ROOT, 'database', 'preflight', '027_preflight.sql');
const CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4';

function readSql(file) {
  return fs.readFileSync(file, 'utf8');
}

/** The single source of the pattern inside the proposal, declared once and referenced everywhere. */
function declaredPattern() {
  const match = /-- UUID_V4_PATTERN:\s*(\S+)/.exec(readSql(UP_SQL));
  assert.ok(match, 'the up-migration must declare its pattern on a UUID_V4_PATTERN line');
  return match[1];
}

const SAMPLES = [
  // Valid v4 (RFC 4122 variant, version nibble 4), both cases.
  '11111111-1111-4111-8111-111111111111',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  'F47AC10B-58CC-4372-A567-0E02B2C3D479',
  '00000000-0000-4000-8000-000000000000',
  // Wrong version nibble.
  'f47ac10b-58cc-1372-a567-0e02b2c3d479',
  'f47ac10b-58cc-5372-a567-0e02b2c3d479',
  // Wrong variant nibble.
  '11111111-1111-4111-1111-111111111111',
  '11111111-1111-4111-c111-111111111111',
  // Not a UUID at all.
  'RAE-00000001',
  'EMP-9001',
  '',
  '11111111-1111-4111-8111-11111111111',
  '11111111-1111-4111-8111-1111111111111',
  '11111111-1111-4111-8111-11111111111g',
  '111111111111411181111111111111111111',
  ' 11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111 ',
];

test('the proposal and the policy module accept exactly the same values', () => {
  const pattern = declaredPattern();
  const sqlEquivalent = new RegExp(pattern);
  for (const sample of SAMPLES) {
    assert.equal(
      sqlEquivalent.test(sample),
      isUuidV4(sample),
      `SQL and JS disagree on ${JSON.stringify(sample)}: sql=${sqlEquivalent.test(sample)} js=${isUuidV4(sample)}`,
    );
  }
});

test('the declared pattern is exactly the one used in the ALTER and the post-condition', () => {
  const pattern = declaredPattern();
  const sql = readSql(UP_SQL);
  const occurrences = sql.split(pattern).length - 1;
  assert.ok(occurrences >= 3, `expected the pattern in the marker, the ALTER and the post-condition; found ${occurrences}`);
});

test('the preflight probes the engine with the same pattern, including the four rejection cases', () => {
  const pattern = declaredPattern();
  const sql = readSql(PREFLIGHT_SQL);
  assert.ok(sql.includes(pattern), 'the preflight must use the declared pattern');
  for (const probe of ['accepts_a_v4', 'rejects_version_1', 'rejects_wrong_variant', 'rejects_non_uuid', 'rejects_trailing_space']) {
    assert.ok(sql.includes(probe), `the preflight is missing the ${probe} probe`);
  }
  // A preflight that could write would defeat its purpose.
  for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'CREATE ', 'PREPARE ', 'EXECUTE ']) {
    assert.equal(sql.toUpperCase().includes(forbidden), false, `the preflight must be read-only, found ${forbidden}`);
  }
});

test('the preflight never selects a nonconforming employee_uid, whole or partial', () => {
  const sql = readSql(PREFLIGHT_SQL);
  // A nonconforming UID may be a pasted code or national ID, so even a prefix is a disclosure.
  for (const leak of ['LEFT(employee_uid', 'RIGHT(employee_uid', 'SUBSTRING(employee_uid, 1,', 'employee_uid AS', 'employee_uid_masked']) {
    assert.equal(sql.includes(leak), false, `the preflight must not select any part of the UID: found ${leak}`);
  }
  assert.ok(sql.includes('SHA2(employee_uid, 256)'), 'offenders must be identified by digest only');
});

test('the up-migration is additive, guarded and names one constraint', () => {
  const sql = readSql(UP_SQL);
  assert.ok(sql.includes(CONSTRAINT_NAME));
  assert.ok(sql.includes('ADD CONSTRAINT'), 'the proposal must only add a constraint');
  assert.ok(sql.includes('information_schema.TABLE_CONSTRAINTS'), 'the proposal must be idempotent');
  assert.ok(sql.includes('CHAR_LENGTH(employee_uid) = 36'), 'the length must be part of the check');
  // It must not rewrite data: the whole point of ADR-012 is that a UID is never re-keyed.
  for (const forbidden of ['UPDATE employees', 'DELETE FROM', 'DROP TABLE', 'TRUNCATE']) {
    assert.equal(sql.includes(forbidden), false, `a shape constraint must not ${forbidden}`);
  }
  assert.ok(/NOT APPLIED/i.test(sql), 'the header must state that this is not applied');
});

test('the rollback drops the same constraint and is guarded', () => {
  const sql = readSql(DOWN_SQL);
  assert.ok(sql.includes(CONSTRAINT_NAME));
  assert.ok(sql.includes('DROP CONSTRAINT'));
  assert.ok(sql.includes('information_schema.TABLE_CONSTRAINTS'));
  assert.equal(sql.includes('UPDATE '), false, 'a rollback must not rewrite rows either');
});

test('the proposal is not in the migration ledger directory, so the runner cannot apply it', () => {
  // scripts/migrate.mjs reads only database/migrations/; a proposal must never live there unapproved.
  const ledgerCopies = fs.readdirSync(path.join(REPO_ROOT, 'database', 'migrations'))
    .filter((name) => name.includes('employee_uid_uuid_v4'));
  assert.deepEqual(ledgerCopies, [], 'the UUIDv4 check must stay out of database/migrations until approved');
});
