import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  dryRun,
  inspectSource,
  reconcile,
  transformSource,
  validateSource,
} from './lib.mjs';

const samplePath = new URL('./sample/synthetic-source.json', import.meta.url);
const sampleText = await readFile(samplePath, 'utf8');
const sample = JSON.parse(sampleText);

test('mapping: synthetic sample passes validation and drops secrets', () => {
  const validation = validateSource(sample);
  assert.equal(validation.ok, true);
  const transformed = transformSource(sample);
  assert.equal(transformed.employees[0].password_hash, null);
  // The UID is copied from the source, never derived from the employee code (ADR-012 rule 3).
  assert.equal(transformed.employees[0].employee_uid, sample.employees[0].employee_uid);
  assert.equal(transformed.employee_leave[0].leave_id, 'SYN-LV-1');
  assert.equal(transformed.omitted.refresh_tokens.includes('do not copy'), true);
});

test('mapping: a missing employee_uid is a validation failure, not a derived identity', () => {
  const noUid = structuredClone(sample);
  delete noUid.employees[0].employee_uid;
  const validation = validateSource(noUid);
  assert.equal(validation.ok, false);
  const codes = validation.errors.map((e) => e.code);
  assert.ok(codes.includes('EMPLOYEE_UID_REQUIRED'), `expected EMPLOYEE_UID_REQUIRED, got ${codes.join(',')}`);
  // And the transform must refuse rather than invent one.
  assert.throws(() => transformSource(noUid), /employee_uid must be a version-4 UUID/);
});

test('mapping: a non-v4 employee_uid is rejected', () => {
  const wrongShape = structuredClone(sample);
  wrongShape.employees[0].employee_uid = 'SYN-001';
  const validation = validateSource(wrongShape);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.code === 'INVALID_UUID'));
  assert.throws(() => transformSource(wrongShape), /version-4 UUID/);
});

test('mapping: the employee UID is identical whatever the employee code is', () => {
  // Regression for the removed `stableEmployeeUid`: changing only the code must not change the UID, and
  // changing only the UID must be honoured. If a derivation is ever reintroduced, this fails.
  const renamed = structuredClone(sample);
  const original = renamed.employees[0].employee_uid;
  renamed.employees[0].employee_id = 'SYN-RENAMED';
  // The identifier rows reference the old code, so validate the employee row in isolation.
  const transformed = transformSource({ employees: [renamed.employees[0]] });
  assert.equal(transformed.employees[0].employee_uid, original);
});

test('guard: the module cannot derive an employee UID anywhere', async () => {
  // ADR-012 rule 3. The removed `stableEmployeeUid` was a sha256 of the employee code, reshaped to pass a v4
  // check. A behavioural test alone cannot prove no derivation exists on another path, so this asserts the
  // source: no such export, and no sha256 over an identity field.
  const source = await readFile(new URL('./lib.mjs', import.meta.url), 'utf8');
  assert.equal(/export\s+function\s+stableEmployeeUid/.test(source), false,
    'stableEmployeeUid must not be exported (ADR-012 rule 3)');
  assert.equal(/export\s+(function|const)\s+\w*[Dd]erive\w*Uid/.test(source), false,
    'no UID-derivation helper may be exported');
  // A sha256 over an employee identifier would be the same defect under a new name.
  const forbidden = [
    /sha256[^\n]*employee_?[Ii]d/,
    /employee_?[Ii]d[^\n]*sha256/,
    /createHash\([^)]*\)[\s\S]{0,80}employee_?[Ii]d/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `lib.mjs must not hash an employee identifier: ${pattern}`);
  }
});

test('mapping: duplicate employee code and balance mismatch fail', () => {
  const broken = structuredClone(sample);
  broken.employees.push({ ...broken.employees[0] });
  broken.leave_balance[0].remaining_days = 0;
  const result = validateSource(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'DUPLICATE_EMPLOYEE_ID'));
  assert.ok(result.errors.some((item) => item.code === 'BALANCE_MISMATCH'));
});

test('mapping: orphan attendance and overlapping leave fail', () => {
  const broken = structuredClone(sample);
  broken.daily_attendance.push({
    employee_id: 'MISSING',
    date: '2026-03-03',
    status: 'present',
  });
  broken.staging_leave.push({
    leave_id: 'SYN-LV-2',
    employee_id: 'SYN-001',
    leave_type: 'sick',
    start_date: '2026-03-10',
    end_date: '2026-03-11',
    status: 'approved',
    match_status: 'matched',
  });
  const result = validateSource(broken);
  assert.ok(result.errors.some((item) => item.code === 'ORPHAN_ATTENDANCE'));
  assert.ok(result.errors.some((item) => item.code === 'OVERLAP'));
});

test('dry-run is deterministic and resumable without a database', () => {
  const first = dryRun(sample, { sourceText: sampleText });
  const second = dryRun(sample, { sourceText: sampleText });
  assert.equal(first.writesDatabase, false);
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.plan.employees.insert.length, 2);
  const resumed = dryRun(sample, {
    sourceText: sampleText,
    appliedKeys: first.plan.employees.insert.map((key) => `employees:${key}`),
  });
  assert.deepEqual(resumed.plan.employees.insert, []);
  assert.equal(resumed.plan.employees.skip.length, 2);
});

test('reconcile compares row counts and checksum', () => {
  const report = dryRun(sample, { sourceText: sampleText });
  const expected = {
    requireValid: true,
    checksum: report.checksum,
    tables: {
      employees: { rows: 2 },
      daily_attendance: { rows: 1 },
      employee_leave: { rows: 1 },
    },
  };
  assert.equal(reconcile(report, expected).ok, true);
  const bad = reconcile(report, { ...expected, tables: { employees: { rows: 9 } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches[0].code, 'ROW_COUNT');
});

test('scope mapping accepts opaque org codes and rejects an invented hierarchy', () => {
  const withScope = structuredClone(sample);
  withScope.authorization_grants = [
    { employee_id: 'SYN-002', role: 'MANAGER', scope_type: 'org_unit', org_unit_code: 'OU-SYN-1' },
  ];
  withScope.employee_org_membership = [
    { employee_id: 'SYN-001', org_unit_code: 'OU-SYN-1' },
  ];
  assert.equal(validateSource(withScope).ok, true);
  const transformed = transformSource(withScope);
  assert.equal(transformed.authorization_grants[0].org_unit_code, 'OU-SYN-1');

  const invented = structuredClone(withScope);
  invented.authorization_grants[0] = {
    employee_id: 'SYN-002',
    role: 'MANAGER',
    scope_type: 'organization',
  };
  const result = validateSource(invented);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'HIERARCHY_UNKNOWN'));
});

test('inspect lists fields and does not treat the sample as authoritative', () => {
  const inspected = inspectSource(sample);
  assert.equal(inspected.manifest.authority, 'not-authoritative');
  assert.equal(inspected.tables.employees.rows, 2);
  assert.ok(inspected.tables.employees.fields.includes('email'));
});
