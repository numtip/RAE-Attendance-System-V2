const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EMPLOYEE_TYPES,
  ASSIGNMENT_CONFLICT_CODES,
  normalizeEffectiveDate,
  windowsOverlapWithinEmployee,
  windowsOverlapForCode,
  isEffectiveOn,
  normalizeAssignmentInput,
} = require('../src/domain/employeeAssignment');
const { createFixtureEmployeeAssignmentRepository } = require('../src/repositories/fixtureEmployeeAssignmentRepository');
const { createEmployeeAssignmentService } = require('../src/services/employeeAssignmentService');

const EMP_A = '11111111-1111-1111-1111-111111111111';
const EMP_B = '22222222-2222-2222-2222-222222222222';
const ADMIN = { employeeUid: '99999999-9999-9999-9999-999999999999', role: 'admin' };
const EMPLOYEE_A = { employeeUid: EMP_A, role: 'user' };

function baseInput(overrides = {}) {
  return {
    employeeUid: EMP_A,
    employeeCode: 'E-0001',
    department: 'Faculty of Science',
    position: 'Lecturer',
    employeeType: 'university',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    sourceSystem: 'hr_import',
    sourceReference: 'batch-1',
    ...overrides,
  };
}

function makeRepo(rows = []) {
  return createFixtureEmployeeAssignmentRepository(rows);
}

function serviceWith(rows = []) {
  const employeeAssignments = makeRepo(rows);
  return {
    employeeAssignments,
    service: createEmployeeAssignmentService({ repositories: { employeeAssignments } }),
  };
}

test('EMPLOYEE_TYPES exposes the three supported types', () => {
  assert.deepEqual([...EMPLOYEE_TYPES], ['university', 'department', 'contract']);
});

test('normalizeAssignmentInput returns the canonical shape', () => {
  assert.deepEqual(normalizeAssignmentInput(baseInput()), {
    employeeUid: EMP_A,
    employeeCode: 'E-0001',
    department: 'Faculty of Science',
    position: 'Lecturer',
    employeeType: 'university',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    sourceSystem: 'hr_import',
    sourceReference: 'batch-1',
  });
});

test('normalizeAssignmentInput trims text and nulls empty optional fields', () => {
  const normalized = normalizeAssignmentInput(baseInput({
    employeeUid: `  ${EMP_A}  `,
    employeeCode: '  E-0001  ',
    department: '  Science  ',
    position: '   ',
    sourceReference: '',
  }));
  assert.equal(normalized.employeeUid, EMP_A);
  assert.equal(normalized.employeeCode, 'E-0001');
  assert.equal(normalized.department, 'Science');
  assert.equal(normalized.position, null);
  assert.equal(normalized.sourceReference, null);
});

test('normalizeAssignmentInput rejects each invalid field with its code', () => {
  const cases = [
    [{ employeeUid: '   ' }, 'ASSIGNMENT_INVALID_EMPLOYEE'],
    [{ employeeUid: 12345 }, 'ASSIGNMENT_INVALID_EMPLOYEE'],
    [{ employeeCode: '' }, 'ASSIGNMENT_INVALID_CODE'],
    [{ employeeCode: 'X'.repeat(51) }, 'ASSIGNMENT_INVALID_CODE'],
    [{ department: '' }, 'ASSIGNMENT_INVALID_DEPARTMENT'],
    [{ department: 'D'.repeat(101) }, 'ASSIGNMENT_INVALID_DEPARTMENT'],
    [{ position: 'P'.repeat(101) }, 'ASSIGNMENT_INVALID_POSITION'],
    [{ employeeType: 'agency' }, 'ASSIGNMENT_INVALID_EMPLOYEE_TYPE'],
    [{ effectiveFrom: 'nope' }, 'ASSIGNMENT_INVALID_DATE'],
    [{ effectiveFrom: null }, 'ASSIGNMENT_INVALID_DATE'],
    [{ sourceSystem: '' }, 'ASSIGNMENT_INVALID_SOURCE'],
    [{ sourceReference: 'R'.repeat(256) }, 'ASSIGNMENT_INVALID_SOURCE'],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => normalizeAssignmentInput(baseInput(override)),
      (error) => error.status === 400 && error.code === code,
    );
  }
});

test('normalizeAssignmentInput rejects effective_to earlier than effective_from', () => {
  assert.throws(
    () => normalizeAssignmentInput(baseInput({ effectiveFrom: '2026-07-01', effectiveTo: '2026-06-30' })),
    (error) => error.status === 400 && error.code === 'ASSIGNMENT_INVALID_WINDOW',
  );
});

test('normalizeEffectiveDate accepts a Date, an ISO string and empty values', () => {
  assert.equal(normalizeEffectiveDate('2026-07-01', 'effective_from'), '2026-07-01');
  assert.equal(normalizeEffectiveDate(new Date(Date.UTC(2026, 6, 1)), 'effective_from'), '2026-07-01');
  assert.equal(normalizeEffectiveDate(null, 'effective_from'), null);
  assert.equal(normalizeEffectiveDate(undefined, 'effective_from'), null);
  assert.equal(normalizeEffectiveDate('', 'effective_from'), null);
});

test('normalizeEffectiveDate rejects bad values without echoing them', () => {
  const bads = ['01/07/2026', '2026-02-31', 'not-a-date', 20260701, {}, new Date('invalid')];
  for (const bad of bads) {
    assert.throws(
      () => normalizeEffectiveDate(bad, 'effective_from'),
      (error) => error.status === 400
        && error.code === 'ASSIGNMENT_INVALID_DATE'
        && !String(error.message).includes(String(bad)),
    );
  }
});

test('windowsOverlapWithinEmployee follows the NULL-safe rule', () => {
  const open = { effectiveFrom: '2026-01-01', effectiveTo: null };
  assert.equal(windowsOverlapWithinEmployee(open, { effectiveFrom: '2030-01-01', effectiveTo: '2030-12-31' }), true);
  assert.equal(windowsOverlapWithinEmployee({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, { effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31' }), false);
  assert.equal(windowsOverlapWithinEmployee({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, { effectiveFrom: '2026-06-30', effectiveTo: '2026-12-31' }), true);
  assert.equal(windowsOverlapForCode(open, open), true);
});

test('isEffectiveOn includes both boundary dates and open-ended tails', () => {
  const record = { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' };
  assert.equal(isEffectiveOn(record, '2026-01-01'), true);
  assert.equal(isEffectiveOn(record, '2026-06-30'), true);
  assert.equal(isEffectiveOn(record, '2025-12-31'), false);
  assert.equal(isEffectiveOn(record, '2026-07-01'), false);
  assert.equal(isEffectiveOn({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2099-01-01'), true);
});

test('fixture insert then findEffectiveOn resolves before, inside and after', async () => {
  const repo = makeRepo();
  const stored = await repo.insert(baseInput());
  assert.ok(stored.assignmentUid);
  assert.equal(stored.effectiveFrom, '2026-01-01');
  assert.equal(stored.effectiveTo, '2026-06-30');
  assert.equal(await repo.findEffectiveOn(EMP_A, '2025-12-31'), null);
  assert.equal((await repo.findEffectiveOn(EMP_A, '2026-03-15')).assignmentUid, stored.assignmentUid);
  assert.equal(await repo.findEffectiveOn(EMP_A, '2026-07-01'), null);
});

test('fixture listByEmployeeUid filters by onDate and orders by effective_from', async () => {
  const repo = makeRepo();
  await repo.insert(baseInput({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }));
  await repo.insert(baseInput({ effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31' }));
  const all = await repo.listByEmployeeUid(EMP_A);
  assert.deepEqual(all.map((row) => row.effectiveFrom), ['2026-01-01', '2026-07-01']);
  const onDate = await repo.listByEmployeeUid(EMP_A, { onDate: '2026-08-15' });
  assert.equal(onDate.length, 1);
  assert.equal(onDate[0].effectiveFrom, '2026-07-01');
});

test('fixture rejects an overlapping window for the same employee', async () => {
  const repo = makeRepo();
  await repo.insert(baseInput());
  await assert.rejects(
    () => repo.insert(baseInput({ effectiveFrom: '2026-06-01', effectiveTo: '2026-08-31' })),
    (error) => error.status === 409 && error.code === ASSIGNMENT_CONFLICT_CODES.OVERLAP,
  );
});

test('fixture accepts adjacent non-overlapping intervals', async () => {
  const repo = makeRepo();
  await repo.insert(baseInput({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }));
  const second = await repo.insert(baseInput({ effectiveFrom: '2026-07-01', effectiveTo: null }));
  assert.equal(second.effectiveTo, null);
  assert.equal(repo.all().length, 2);
});

test('fixture rejects the same employee_code owned by another employee over an overlapping window', async () => {
  const repo = makeRepo();
  await repo.insert(baseInput());
  await assert.rejects(
    () => repo.insert(baseInput({ employeeUid: EMP_B, effectiveFrom: '2026-03-01', effectiveTo: '2026-09-30' })),
    (error) => error.status === 409 && error.code === ASSIGNMENT_CONFLICT_CODES.CODE_CONFLICT,
  );
  const later = await repo.insert(baseInput({ employeeUid: EMP_B, effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31' }));
  assert.equal(later.employeeUid, EMP_B);
});

test('fixture rejects a duplicate effective_from for the same employee', async () => {
  const repo = makeRepo();
  await repo.insert(baseInput());
  await assert.rejects(
    () => repo.insert(baseInput({ effectiveTo: '2026-12-31' })),
    (error) => error.status === 409 && error.code === 'ASSIGNMENT_DUPLICATE_EFFECTIVE_FROM',
  );
});

test('fixture closeAssignment truncates the window and keeps earlier dates effective', async () => {
  const repo = makeRepo();
  const stored = await repo.insert(baseInput({ effectiveFrom: '2026-01-01', effectiveTo: null }));
  const closed = await repo.closeAssignment(stored.assignmentUid, EMP_A, '2026-06-30');
  assert.equal(closed.effectiveTo, '2026-06-30');
  assert.equal(await repo.findEffectiveOn(EMP_A, '2026-07-01'), null);
  assert.equal((await repo.findEffectiveOn(EMP_A, '2026-06-30')).assignmentUid, stored.assignmentUid);
  await assert.rejects(
    () => repo.closeAssignment(stored.assignmentUid, EMP_A, '2025-12-31'),
    (error) => error.status === 400 && error.code === 'ASSIGNMENT_INVALID_WINDOW',
  );
  assert.equal(await repo.closeAssignment('00000000-0000-0000-0000-000000000000', EMP_A, '2026-06-30'), null);
});

test('service read scope: an employee cannot read another employee assignments', async () => {
  const { service, employeeAssignments } = serviceWith();
  await employeeAssignments.insert(baseInput({ employeeUid: EMP_A }));
  await employeeAssignments.insert(baseInput({ employeeUid: EMP_B, employeeCode: 'E-0002' }));
  await assert.rejects(
    () => service.listForEmployee(EMPLOYEE_A, EMP_B),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  const own = await service.listForEmployee(EMPLOYEE_A, EMP_A);
  assert.equal(own.length, 1);
  assert.equal(own[0].employeeUid, EMP_A);
});

test('service effectiveOn returns the record or ASSIGNMENT_NOT_EFFECTIVE', async () => {
  const { service, employeeAssignments } = serviceWith();
  await employeeAssignments.insert(baseInput());
  const found = await service.effectiveOn(EMPLOYEE_A, EMP_A, '2026-03-01');
  assert.equal(found.employeeUid, EMP_A);
  await assert.rejects(
    () => service.effectiveOn(EMPLOYEE_A, EMP_A, '2026-12-01'),
    (error) => error.status === 404 && error.code === 'ASSIGNMENT_NOT_EFFECTIVE',
  );
});

test('service create is administrator-only and succeeds for an admin', async () => {
  const { service } = serviceWith();
  await assert.rejects(
    () => service.create(EMPLOYEE_A, baseInput()),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  const created = await service.create(ADMIN, baseInput());
  assert.equal(created.employeeUid, EMP_A);
  assert.equal(created.sourceSystem, 'hr_import');
});

test('service close is administrator-only and succeeds for an admin', async () => {
  const { service, employeeAssignments } = serviceWith();
  const stored = await employeeAssignments.insert(baseInput({ effectiveTo: null }));
  await assert.rejects(
    () => service.close(EMPLOYEE_A, stored.assignmentUid, { employeeUid: EMP_A, effectiveTo: '2026-06-30' }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  const closed = await service.close(ADMIN, stored.assignmentUid, { employeeUid: EMP_A, effectiveTo: '2026-06-30' });
  assert.equal(closed.effectiveTo, '2026-06-30');
});

test('validator errors never echo the rejected value', () => {
  const marker = 'pii-marker-1180200015351';
  const tooLongCode = `${marker}${'x'.repeat(40)}`;
  const tooLongDepartment = `${marker}${'y'.repeat(100)}`;
  const throwers = [
    () => normalizeAssignmentInput(baseInput({ employeeCode: tooLongCode })),
    () => normalizeAssignmentInput(baseInput({ department: tooLongDepartment })),
    () => normalizeAssignmentInput(baseInput({ employeeType: marker })),
    () => normalizeEffectiveDate(marker, 'effective_from'),
  ];
  for (const thrower of throwers) {
    assert.throws(thrower, (error) => error.status === 400 && !String(error.message).includes(marker));
  }
});
