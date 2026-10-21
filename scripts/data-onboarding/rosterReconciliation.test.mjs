#!/usr/bin/env node
/**
 * Tests for the roster reconciliation. Synthetic fixtures only — no real roster row, name, email or national
 * ID is read, written or asserted anywhere in this file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  CONFLICT_KIND,
  CHANGE_KIND,
  normalizeRosterRow,
  normalizeMasterRow,
  reconcileRoster,
  summarize,
  assertNoPersonalData,
  assertLocalOutputPath,
  resolveLocalOutputPath,
} from './rosterReconciliation.mjs';
import { parseCsv, decodeCsvBuffer } from './csvText.mjs';

test('the CSV reader handles a BOM, CRLF, quoted commas and doubled quotes', () => {
  const buffer = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('ID HIP,name,c_name\r\n"9001","Fixture, One","Quoted ""Name"""\r\n'),
  ]);
  const rows = parseCsv(decodeCsvBuffer(buffer));
  assert.deepEqual(rows[0], ['ID HIP', 'name', 'c_name']);
  assert.deepEqual(rows[1], ['9001', 'Fixture, One', 'Quoted "Name"']);
  assert.equal(rows.length, 2, 'a BOM must not create an empty first header cell');
});

test('the CSV reader keeps a Thai header intact and drops blank rows', () => {
  const rows = parseCsv('ID HIP,คำอธิบาย\n9001,พนักงานมหาวิทยาลัย\n\n');
  assert.deepEqual(rows, [['ID HIP', 'คำอธิบาย'], ['9001', 'พนักงานมหาวิทยาลัย']]);
});

let counter = 0;
/**
 * A 13-digit value that deliberately FAILS the Thai checksum, so it is structurally incapable of being a real
 * citizen ID. Built at runtime so no checksum-valid literal is ever committed: the repo's fixture-hygiene guard
 * (present on the slice stack, not on the base branch this file was written against) bans exactly that.
 */
function syntheticNationalId() {
  counter += 1;
  const twelve = `1101700${String(counter).padStart(5, '0')}`;
  const sum = twelve.split('').reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  const wrongCheckDigit = (11 - (sum % 11)) % 10;
  return twelve + String((wrongCheckDigit + 1) % 10);
}

function roster(overrides = {}) {
  const nationalId = overrides.nationalId ?? syntheticNationalId();
  return normalizeRosterRow({
    'ID HIP': overrides.code ?? '9001',
    name: overrides.nameTh ?? 'Fixture',
    c_name: overrides.cNameTh ?? 'Personson',
    'ID card': nationalId,
    email: overrides.email ?? `fixture.${nationalId.slice(-4)}@example.test`,
    'employee type': overrides.employeeType ?? 'university',
    'คำอธิบาย': overrides.description ?? 'พนักงานมหาวิทยาลัย',
    ...overrides.record,
  }, overrides.rowNumber ?? 2);
}

function master(overrides = {}) {
  return normalizeMasterRow({
    report_code: overrides.code ?? '9001',
    full_name_th: overrides.fullName ?? 'Fixture Personson',
    department_current: overrides.department ?? 'Fixture Department',
    employment_status: overrides.employmentStatus ?? 'active',
    active: overrides.active ?? true,
    in_attendance_evidence: overrides.inAttendanceEvidence ?? 'yes',
    attendance_rows: overrides.attendanceRows ?? 365,
    ...overrides.record,
  });
}

// --- parsing -----------------------------------------------------------------------------------------

test('a roster row keeps name and c_name separate: the split is not decided here', () => {
  const row = roster({ nameTh: 'Fixture', cNameTh: 'Personson' });
  assert.equal(row.nameTh, 'Fixture');
  assert.equal(row.cNameTh, 'Personson');
  assert.equal(row.fullNameCandidate, 'Fixture Personson');
  assert.equal(row.code, '9001');
});

test('emails are normalized to lowercase and the employee_type is lowercased for comparison', () => {
  const row = roster({ email: 'Mixed.Case@Example.Test', employeeType: 'University' });
  assert.equal(row.email, 'mixed.case@example.test');
  assert.equal(row.employeeType, 'university');
});

test('the master reader accepts report_code, device_code, or employee_code as the join key', () => {
  assert.equal(master({ record: { report_code: '9001', device_code: '' } }).code, '9001');
  assert.equal(master({ record: { report_code: '', device_code: '9002' } }).code, '9002');
  assert.equal(master({ record: { report_code: '', device_code: '', employee_code: '9003' } }).code, '9003');
});

// --- reconciliation ----------------------------------------------------------------------------------

test('a matched row with an identical name is MATCHED and reports no change', () => {
  const result = reconcileRoster({ rosterRows: [roster()], masterRows: [master()] });
  assert.deepEqual(result.counts, {
    roster_rows: 1,
    master_rows: 1,
    master_codes: 1,
    master_rows_unkeyable: 0,
    matched: 1,
    matched_with_changes: 0,
    missing_from_roster: 0,
    extra_in_roster: 0,
    conflicts: 0,
    conflicting_rows: 0,
  });
  assert.deepEqual(result.changed, []);
});

test('a name that differs from the master is a CHANGE, not a new person', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ nameTh: 'Renamed' })],
    masterRows: [master({ fullName: 'Fixture Personson' })],
  });
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.matched_with_changes, 1);
  assert.deepEqual(result.changed[0].fields, [CHANGE_KIND.NAME]);
  assert.equal(result.counts.extra_in_roster, 0);
});

test('a master code absent from the roster is reported as missing and never as a removal', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ code: '9001' })],
    masterRows: [master({ code: '9001' }), master({ code: '9002', attendanceRows: 337 })],
  });
  assert.equal(result.counts.missing_from_roster, 1);
  assert.equal(result.missing[0].code, '9002');
  assert.equal(result.missing[0].attendanceRows, 337);
  assert.equal(result.missing[0].inAttendanceEvidence, 'yes');
  // The module must be explicit that absence from a roster is not a resignation.
  assert.match(result.preservationNote, /not a resignation/i);
});

test('a roster code with no master row is reported as EXTRA, not silently dropped', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ code: '9100' })],
    masterRows: [master({ code: '9001' })],
  });
  assert.equal(result.counts.extra_in_roster, 1);
  assert.equal(result.extra[0].code, '9100');
  assert.equal(result.counts.matched, 0);
});

test('a duplicated roster code is a conflict', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ code: '9001' }), roster({ code: '9001' })],
    masterRows: [master({ code: '9001' })],
  });
  assert.ok(result.conflicts.some((c) => c.kind === CONFLICT_KIND.DUPLICATE_HIP_CODE));
  assert.equal(result.counts.conflicting_rows, 1);
});

test('one national ID under two codes is a conflict', () => {
  const shared = syntheticNationalId();
  const result = reconcileRoster({
    rosterRows: [roster({ code: '9001', nationalId: shared }), roster({ code: '9002', nationalId: shared })],
    masterRows: [master({ code: '9001' }), master({ code: '9002' })],
  });
  assert.ok(result.conflicts.some((c) => c.kind === CONFLICT_KIND.NATIONAL_ID_UNDER_TWO_CODES));
});

test('an employee_type outside the enum is a conflict, never coerced to a default', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ employeeType: 'civil-servant' })],
    masterRows: [master()],
  });
  assert.ok(result.conflicts.some((c) => c.kind === CONFLICT_KIND.UNKNOWN_EMPLOYEE_TYPE));
});

test('a roster row without a 13-digit national ID or a shaped email is flagged', () => {
  const result = reconcileRoster({
    rosterRows: [
      roster({ nationalId: '', email: '' }),
      roster({ code: '9002', nationalId: '12345', email: 'not-an-email' }),
    ],
    masterRows: [master()],
  });
  const kinds = result.conflicts.map((c) => c.kind);
  assert.ok(kinds.includes(CONFLICT_KIND.MISSING_NATIONAL_ID));
  assert.ok(kinds.includes(CONFLICT_KIND.MISSING_EMAIL));
});

test('a master row with no usable code is reported, not silently dropped', () => {
  const result = reconcileRoster({
    rosterRows: [roster({ code: '9001' })],
    masterRows: [
      master({ code: '9001' }),
      // One real row has neither a device code nor an employee code; both fields are empty.
      master({ record: { report_code: '', device_code: '', employee_code: '', source_workbook_row: '11' } }),
    ],
  });
  assert.equal(result.counts.master_rows, 2);
  assert.equal(result.counts.master_codes, 1);
  assert.equal(result.counts.master_rows_unkeyable, 1);
  assert.ok(result.conflicts.some((c) => c.kind === CONFLICT_KIND.MASTER_ROW_WITHOUT_CODE));
  // The population must still add up: codes + unkeyable === rows.
  assert.equal(result.counts.master_codes + result.counts.master_rows_unkeyable, result.counts.master_rows);
});

test('a source without attendance columns reports UNKNOWN, never a false zero', () => {
  const withoutColumns = reconcileRoster({
    rosterRows: [roster({ code: '9001' })],
    masterRows: [master({ code: '9001' }), master({ code: '9002', record: { in_attendance_evidence: '', attendance_rows: '' } })],
  });
  const summary = summarize(withoutColumns);
  assert.equal(summary.missing.attendance_evidence_available, false);
  assert.equal(summary.missing.with_attendance_evidence, null);

  const withColumns = reconcileRoster({
    rosterRows: [roster({ code: '9001' })],
    masterRows: [master({ code: '9001' }), master({ code: '9002', attendanceRows: 337 })],
  });
  const withSummary = summarize(withColumns);
  assert.equal(withSummary.missing.attendance_evidence_available, true);
  assert.equal(withSummary.missing.with_attendance_evidence, 1);
});

test('a master row with no name is still counted in the population', () => {
  const result = reconcileRoster({
    rosterRows: [],
    masterRows: [master({ code: '9001', fullName: '' }), master({ code: '9002', fullName: '' })],
  });
  assert.equal(result.counts.master_rows, 2);
  assert.equal(result.counts.missing_from_roster, 2);
  assert.equal(summarize(result).missing.without_a_confirmed_name, 2);
});

// --- redaction and output guards ---------------------------------------------------------------------

test('the committed summary carries counts only, never a code or a person', () => {
  const result = reconcileRoster({ rosterRows: [roster({ code: '9001' })], masterRows: [master({ code: '9001' })] });
  const summary = summarize(result);
  assertNoPersonalData(summary);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('9001'), false, 'a HIP code is an identifier and does not belong in the summary');
  assert.equal(serialized.includes('Fixture'), false);
});

test('the personal-data guard refuses a national ID and an email in any nested position', () => {
  assert.throws(() => assertNoPersonalData({ counts: {}, leak: '9900000000002' }), /13-digit/);
  assert.throws(() => assertNoPersonalData({ nested: [{ email: 'a.person@example.test' }] }), /email address/);
  assert.doesNotThrow(() => assertNoPersonalData({ counts: { matched: 49, missing_from_roster: 5 } }));
});

test('detail output is restricted to the gitignored database/local tree', () => {
  assert.equal(
    assertLocalOutputPath('database/local/f4-20261021/reconciliation.json'),
    'database/local/f4-20261021/reconciliation.json',
  );
  assert.equal(
    assertLocalOutputPath('database\\local\\f4-20261021\\reconciliation.json'),
    'database/local/f4-20261021/reconciliation.json',
  );
  for (const bad of ['docs/reconciliation.json', 'database/reconciliation.json', 'database/local/../x.json', 'database/local/x.txt', '']) {
    assert.throws(() => assertLocalOutputPath(bad), /database\/local/);
  }
});

test('the detail path is resolved against the repository root, not the current directory', () => {
  // Running the CLI from backend/ must not write backend/database/local/..., which is not gitignored.
  assert.equal(
    resolveLocalOutputPath('/repo', 'database/local/f4-20261021/x.json'),
    '/repo/database/local/f4-20261021/x.json',
  );
  assert.equal(
    resolveLocalOutputPath('C:\\repo\\', 'database/local/x.json'),
    'C:/repo/database/local/x.json',
  );
  assert.throws(() => resolveLocalOutputPath('', 'database/local/x.json'), /repoRoot/);
  assert.throws(() => resolveLocalOutputPath('/repo', 'database/local/../../x.json'), /database\/local/);
});

test('the repository actually ignores database/local/ (the guard above is not enough on its own)', () => {
  // Regression: the detail artefact was "gitignored" by assumption. `database/local/` was present only in a
  // dirty working-tree copy of .gitignore, so on a clean clone the per-code detail was committable. This test
  // asks git for its real answer; from an extracted tree (no .git) it falls back to the committed file content.
  const repoRoot = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..', '..',
  );
  const inGitWorkTree = (() => {
    try {
      execFileSync('git.exe', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  if (!inGitWorkTree) {
    // No git here (e.g. a source archive). Fall back to the committed rule, which is the part that ships.
    const ignoreText = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    assert.match(ignoreText, /^database\/local\/$/m, 'the committed .gitignore must ignore database/local/');
    assert.match(ignoreText, /^database\/roster\*\.csv$/m, 'the committed .gitignore must ignore the roster CSV');
    return;
  }

  const ignored = (relPath) => {
    try {
      // `git check-ignore` exits 0 when the path IS ignored, 1 when it is not.
      execFileSync('git.exe', ['check-ignore', '-q', relPath], { cwd: repoRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored('database/local/f4-20261021/reconciliation.json'), true,
    'database/local/ must be ignored by the committed .gitignore, not by a local-only edit');
  assert.equal(ignored('database/roster_rae2027.csv'), true, 'the owner-supplied roster must be ignored');
  // A control: a path that must NOT be ignored, so a broken/empty .gitignore cannot pass this test.
  assert.equal(ignored('backend/src/domain/employeeUidAllocation.js'), false,
    'a source file must never be ignored');
});

test('an unknown employment_status is reported as UNKNOWN instead of being echoed', () => {
  // A malformed or hostile source could put anything in this column; it must not become a summary key.
  const result = reconcileRoster({
    rosterRows: [],
    masterRows: [master({ code: '9001', record: { employment_status: '9900000000002' } })],
  });
  const summary = summarize(result);
  assert.deepEqual(Object.keys(summary.missing.by_employment_status), ['UNKNOWN']);
  assert.doesNotThrow(() => assertNoPersonalData(summary));
  assert.equal(JSON.stringify(summary).includes('9900000000002'), false);
});

test('a malformed row reference is dropped rather than carried into the detail', () => {
  const result = reconcileRoster({
    rosterRows: [],
    masterRows: [master({ record: { report_code: '', device_code: '', employee_code: '', source_workbook_row: 'a.person@example.test' } })],
  });
  assert.equal(result.counts.master_rows_unkeyable, 1);
  assert.equal(result.unkeyable[0].sourceRowRef, '');
  assert.equal(JSON.stringify(result.unkeyable).includes('@'), false);
});

test('the personal-data guard also inspects object keys and numeric values', () => {
  assert.throws(() => assertNoPersonalData({ by_status: { 9900000000002: 1 } }), /object key/);
  assert.throws(() => assertNoPersonalData({ by_status: { 'a.person@example.test': 1 } }), /object key shaped like an email/);
  assert.throws(() => assertNoPersonalData({ counts: { n: 9900000000002 } }), /numeric value/);
  assert.doesNotThrow(() => assertNoPersonalData({ counts: { matched: 49, conflicts: 0 } }));
});

test('a hex content digest is not mistaken for a national ID', () => {
  // Regression: a random sha256 contains a 13-digit run ~5% of the time, so the guard rejected its own input
  // roughly 9% of runs with a misleading PII error. A real national ID is 13 digits and can never be a
  // 32+ character hex digest, so digest values must pass while genuine leaks are still caught.
  for (let i = 0; i < 500; i += 1) {
    const digest = createHash('sha256').update(`fixture-${i}`).digest('hex');
    assert.doesNotThrow(() => assertNoPersonalData({ inputs: { roster: { sha256: digest } } }));
  }
  // A digest-shaped key is fine too; a national-ID-shaped key is still refused.
  assert.doesNotThrow(() => assertNoPersonalData({ by_digest: { [createHash('sha256').update('k').digest('hex')]: 1 } }));
  assert.throws(() => assertNoPersonalData({ by_status: { 9900000000002: 1 } }), /object key/);
});
