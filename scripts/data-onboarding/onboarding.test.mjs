import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  allocateEmployeeIdentity,
  attendanceEmployeeId,
  buildImportBatchFromPersonRecords,
  classifyPersonnelOnboarding,
  dryRun,
  inspectSource,
  PERSONNEL_ID_SOURCE,
  PERSONNEL_ID_VERIFIED,
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
  assert.equal(transformed.employees[0].employee_uid, sample.employees[0].employee_uid);
  assert.equal(transformed.employee_leave[0].leave_id, 'SYN-LV-1');
  assert.equal(transformed.omitted.refresh_tokens.includes('do not copy'), true);
});

test('identity allocation uses an independent UUID and controlled employee code', () => {
  const expectedUid = '20000000-0000-4000-8000-000000000001';
  const allocated = allocateEmployeeIdentity(42, { uuidFactory: () => expectedUid });
  assert.deepEqual(allocated, {
    employee_uid: expectedUid,
    employee_id: 'RAE-00000042',
  });
  assert.equal(attendanceEmployeeId(1), 'RAE-00000001');
  assert.throws(() => attendanceEmployeeId(0));
});

test('employee_uid is required and is never derived from employee_id', () => {
  const missingUid = structuredClone(sample);
  delete missingUid.employees[0].employee_uid;
  const validation = validateSource(missingUid);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => item.code === 'REQUIRED' && item.message.includes('employee_uid')));
  assert.throws(() => transformSource(missingUid), /employee_uid must be allocated/);
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

test('MJU personnel onboarding classifies 34 verified and 16 hold without creating UIDs', () => {
  const records = Array.from({ length: 50 }, (_, index) => ({
    personnelId: index < 34 ? `SYN-PERSONNEL-${String(index + 1).padStart(3, '0')}` : null,
  }));
  const result = classifyPersonnelOnboarding(records, { source: PERSONNEL_ID_SOURCE });
  assert.equal(result.sourceAuthoritative, true);
  assert.equal(result.total, 50);
  assert.equal(result.verified, 34);
  assert.equal(result.hold, 16);
  assert.equal(result.conflicts, 0);
  assert.equal(result.createsEmployeeUid, false);
  assert.equal(
    result.classifications.filter((row) => row.status === PERSONNEL_ID_VERIFIED).length,
    34,
  );
  assert.ok(result.classifications.every((row) => !Object.hasOwn(row, 'employeeUid')));
});

test('personnel onboarding holds duplicate IDs and non-authoritative sources', () => {
  const duplicate = classifyPersonnelOnboarding(
    [{ personnelId: 'SYN-DUP' }, { personnelId: 'SYN-DUP' }],
    { source: PERSONNEL_ID_SOURCE },
  );
  assert.equal(duplicate.verified, 0);
  assert.equal(duplicate.hold, 2);
  assert.equal(duplicate.conflicts, 2);

  const unapproved = classifyPersonnelOnboarding(
    [{ personnelId: 'SYN-001' }],
    { source: 'unknown' },
  );
  assert.equal(unapproved.verified, 0);
  assert.equal(unapproved.hold, 1);
});

test('synthetic fixture (34 ready / 16 hold are fixture counts, not authoritative) builds unique identifiers and dry-run plan', async () => {
  const samplePath = new URL('./sample/person-batch-50-synthetic.json', import.meta.url);
  const parsed = JSON.parse(await readFile(samplePath, 'utf8'));
  const batch = buildImportBatchFromPersonRecords(parsed.persons, {
    source_batch_id: 'test-batch-9-5k',
    person_source: PERSONNEL_ID_SOURCE,
    sequence_start: 1,
  });
  assert.equal(batch.readyCount, 34);
  assert.equal(batch.holdCount, 16);
  assert.equal(batch.uniqueness.ok, true);
  assert.equal(batch.employeeIdRange.from, 'RAE-00000001');
  assert.equal(batch.employeeIdRange.to, 'RAE-00000034');
  assert.equal(batch.bundle.employees.length, 34);
  assert.equal(batch.bundle.employee_identifier.length, 68);
  assert.equal(batch.bundle.identifier_audit.length, 34);
  const report = dryRun(batch.bundle, { sourceText: JSON.stringify(batch.bundle) });
  assert.equal(report.validation.ok, true);
  assert.equal(report.plan.employees.rows, 34);
  assert.equal(report.plan.employee_identifier.rows, 68);
  assert.equal(report.rollbackKeys.length, 102);
});
