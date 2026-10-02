const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createContainer } = require('../src/container');
const {
  createAttendanceComputeService,
  resolveEmployeeUidFromBusinessId,
} = require('../src/services/attendanceComputeService');

function createService(overrides = {}) {
  const repositories = overrides.repositories || createFixtureRepositories();
  return {
    service: createEmployeeIdentityService({ repositories }),
    repositories,
  };
}

test('resolve employee_id -> employee_uid via employees column', async () => {
  const { service } = createService();
  const employee = await service.resolve('employee_id', 'E-USER');
  assert.equal(employee.employeeUid, '22222222-2222-2222-2222-222222222222');
});

test('resolve personnel_id -> employee_uid', async () => {
  const { service } = createService();
  const employee = await service.resolve('personnel_id', 'P-USER-001');
  assert.equal(employee.employeeUid, '22222222-2222-2222-2222-222222222222');
});

test('resolve facescan_id -> employee_uid', async () => {
  const { service } = createService();
  const employee = await service.resolve('facescan_id', 'FS-USER-001');
  assert.equal(employee.employeeUid, '22222222-2222-2222-2222-222222222222');
});

test('resolve national_id -> employee_uid', async () => {
  const { service } = createService();
  const plain = '1180200015351';
  await service.linkIdentifier({
    employeeUid: '22222222-2222-2222-2222-222222222222',
    idType: 'national_id',
    idValue: plain,
  });
  const uid = await service.resolveUid('national_id', plain);
  assert.equal(uid, '22222222-2222-2222-2222-222222222222');
});

test('unknown identifier returns not found', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.resolve('facescan_id', 'FS-MISSING'),
    (error) => error.code === 'EMPLOYEE_NOT_FOUND',
  );
});

test('duplicate identifier rejected across employees', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.linkIdentifier({
      employeeUid: '11111111-1111-1111-1111-111111111111',
      idType: 'facescan_id',
      idValue: 'FS-USER-001',
    }),
    (error) => error.code === 'DUPLICATE_IDENTIFIER',
  );
});

test('same identifier cannot map to two employees', async () => {
  const { service, repositories } = createService();
  await service.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'personnel_id',
    idValue: 'P-DUP-001',
  });
  await assert.rejects(
    () => repositories.employeeIdentifiers.insert({
      employeeUid: '33333333-3333-3333-3333-333333333333',
      idType: 'personnel_id',
      idValue: 'P-DUP-001',
    }),
    (error) => error.code === 'DUPLICATE_IDENTIFIER',
  );
});

test('multiple identifier types may belong to one employee', async () => {
  const { service } = createService();
  const rows = await service.listIdentifiers('22222222-2222-2222-2222-222222222222');
  const types = new Set(rows.map((row) => row.idType));
  assert.ok(types.has('personnel_id'));
  assert.ok(types.has('facescan_id'));
});

test('FK rejects nonexistent employee_uid on link', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.linkIdentifier({
      employeeUid: '99999999-9999-9999-9999-999999999999',
      idType: 'facescan_id',
      idValue: 'FS-ORPHAN',
    }),
    (error) => error.code === 'EMPLOYEE_NOT_FOUND',
  );
});

test('unlink deactivates identifier and resolve fails afterward', async () => {
  const { service } = createService();
  const linked = await service.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'facescan_id',
    idValue: 'FS-TEMP-001',
  });
  await service.unlinkIdentifier({ id: linked.id, employeeUid: linked.employeeUid });
  await assert.rejects(
    () => service.resolve('facescan_id', 'FS-TEMP-001'),
    (error) => error.code === 'EMPLOYEE_NOT_FOUND',
  );
});

test('national_id never appears unmasked in list or errors', async () => {
  const { service } = createService();
  const plain = '1180200015351';
  await service.linkIdentifier({
    employeeUid: '11111111-1111-1111-1111-111111111111',
    idType: 'national_id',
    idValue: plain,
  });
  const listed = await service.listIdentifiers('11111111-1111-1111-1111-111111111111');
  const nationalRow = listed.find((row) => row.idType === 'national_id');
  assert.ok(nationalRow);
  assert.equal(nationalRow.idValue, undefined);
  assert.ok(!nationalRow.idValueMasked.includes(plain));
  assert.match(nationalRow.idValueMasked, /^\*\*\*\*\d{4}$/);

  try {
    await service.resolve('national_id', '0000000000000');
  } catch (error) {
    assert.equal(error.code, 'EMPLOYEE_NOT_FOUND');
    assert.ok(!String(error.message).includes(plain));
    assert.ok(!String(error.message).includes('0000000000000'));
  }
});

test('attendance boundary resolves employee_id and Attendance Core receives employee_uid', async () => {
  const container = createContainer({ dataSource: 'fixture' });
  const uid = await resolveEmployeeUidFromBusinessId(container.repositories, 'E-USER');
  assert.equal(uid, '22222222-2222-2222-2222-222222222222');

  const compute = createAttendanceComputeService({
    container,
    coreClient: {
      async evaluateDay(payload) {
        assert.equal(payload.employee_id, 'E-USER');
        assert.equal(payload.employee_uid, '22222222-2222-2222-2222-222222222222');
        assert.equal(payload.employeeUid, '22222222-2222-2222-2222-222222222222');
        return {
          employee_id: payload.employee_id,
          employee_uid: payload.employee_uid,
          date: payload.date,
          attendance_status: 'PRESENT',
          issues: [],
        };
      },
    },
  });
  const result = await compute.evaluateDay(
    { role: 'admin' },
    { employee_id: 'E-USER', date: '2026-08-03' },
  );
  assert.equal(result.employeeUid, '22222222-2222-2222-2222-222222222222');
});
