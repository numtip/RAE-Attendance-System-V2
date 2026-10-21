/**
 * Guardrails for proposal 027, and parity between the SQL shape rule and the JavaScript rule.
 *
 * Two places encode "what a version-4 UUID is": `domain/employeeUidAllocation.js` (the allocation policy) and the
 * proposed `CHECK` in `docs/proposals/027_employee_uid_uuid_v4.md`. If one drifts, the database would accept a
 * UID the code refuses to mint — or the reverse — and the failure would be invisible until an import.
 *
 * The proposal lives in Markdown, not SQL, because `scripts/secret-scan.mjs` blocks every `.sql` file outside
 * `database/migrations|seeds|rollbacks` and `.gitignore` ignores the rest. Those are deliberate controls; an
 * unapplied DDL change must not be able to slip past them. A Markdown document is reviewable and the runner
 * reads only `database/migrations/`, so this test also asserts the proposal can never be applied by accident.
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
const PROPOSAL = path.join(REPO_ROOT, 'docs', 'proposals', '027_employee_uid_uuid_v4.md');
const CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4';

function readProposal() {
  return fs.readFileSync(PROPOSAL, 'utf8');
}

/** The single source of the pattern inside the proposal, declared once and referenced everywhere. */
function declaredPattern() {
  const match = /-- UUID_V4_PATTERN:\s*(\S+)/.exec(readProposal());
  assert.ok(match, 'the proposal must declare its pattern on a UUID_V4_PATTERN line');
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
  const sqlEquivalent = new RegExp(declaredPattern());
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
  const occurrences = readProposal().split(pattern).length - 1;
  assert.ok(occurrences >= 3, `expected the pattern in the marker, the ALTER and the post-condition; found ${occurrences}`);
});

test('the preflight probes the engine with the same pattern, including the rejection cases', () => {
  const pattern = declaredPattern();
  const sql = readProposal();
  assert.ok(sql.includes(pattern), 'the preflight must use the declared pattern');
  for (const probe of ['accepts_a_v4', 'rejects_version_1', 'rejects_wrong_variant', 'rejects_non_uuid', 'rejects_trailing_space']) {
    assert.ok(sql.includes(probe), `the preflight is missing the ${probe} probe`);
  }
});

/** The first ```sql fenced block of a `## Heading` section. Prose after the block is excluded. */
function sqlBlock(heading) {
  const section = readProposal().split(`## ${heading}`)[1] ?? '';
  const match = /```sql\r?\n([\s\S]*?)```/.exec(section);
  assert.ok(match, `the proposal must contain a fenced sql block under "## ${heading}"`);
  return match[1];
}

test('the preflight is read-only: no DDL, no DML, no dynamic SQL', () => {
  const preflight = sqlBlock('Preflight');
  assert.ok(preflight.length > 0, 'the proposal must contain a preflight section');
  for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'CREATE ', 'PREPARE ', 'EXECUTE ', 'TRUNCATE ']) {
    assert.equal(preflight.toUpperCase().includes(forbidden), false, `the preflight must be read-only, found ${forbidden}`);
  }
});

test('the preflight never selects a nonconforming employee_uid, whole or partial', () => {
  const sql = readProposal();
  // A nonconforming UID may be a pasted code or national ID, so even a prefix is a disclosure.
  for (const leak of ['LEFT(employee_uid', 'RIGHT(employee_uid', 'SUBSTRING(employee_uid, 1,', 'employee_uid AS', 'employee_uid_masked']) {
    assert.equal(sql.includes(leak), false, `the preflight must not select any part of the UID: found ${leak}`);
  }
  assert.ok(sql.includes('SHA2(employee_uid, 256)'), 'offenders must be identified by digest only');
});

test('the up-migration is additive, guarded and names one constraint', () => {
  const sql = readProposal();
  assert.ok(sql.includes(CONSTRAINT_NAME));
  assert.ok(sql.includes('ADD CONSTRAINT'), 'the proposal must only add a constraint');
  assert.ok(sql.includes('information_schema.TABLE_CONSTRAINTS'), 'the proposal must be idempotent');
  assert.ok(sql.includes('CHAR_LENGTH(employee_uid) = 36'), 'the length must be part of the check');
  for (const forbidden of ['UPDATE employees', 'DELETE FROM', 'DROP TABLE', 'TRUNCATE']) {
    assert.equal(sql.includes(forbidden), false, `a shape constraint must not ${forbidden}`);
  }
  assert.ok(/NOT APPLIED/i.test(sql), 'the header must state that this is not applied');
});

test('the rollback drops the same constraint and is guarded', () => {
  const down = sqlBlock('Down');
  assert.ok(down.includes(CONSTRAINT_NAME));
  assert.ok(down.includes('DROP CONSTRAINT'));
  assert.ok(down.includes('information_schema.TABLE_CONSTRAINTS'));
  assert.equal(down.includes('UPDATE '), false, 'a rollback must not rewrite rows either');
});

test('the proposal cannot be applied by the migration runner', () => {
  // scripts/migrate.mjs reads only database/migrations/, and the secret scanner blocks stray .sql. Both are
  // deliberate controls; an unapproved constraint must not be reachable through either.
  const ledgerCopies = fs.readdirSync(path.join(REPO_ROOT, 'database', 'migrations'))
    .filter((name) => name.includes('employee_uid_uuid_v4') || name.startsWith('027'));
  assert.deepEqual(ledgerCopies, [], 'the UUIDv4 check must stay out of database/migrations until approved');
  assert.equal(PROPOSAL.endsWith('.sql'), false, 'the proposal must not be a .sql file the scanner would block');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'database', 'proposals', '027_employee_uid_uuid_v4.up.sql')), false);
});
