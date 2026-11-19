const assert = require('node:assert/strict');
const test = require('node:test');

const { AttendanceRepository } = require('../src/repositories/attendanceRepository');
const { createAttendanceService } = require('../src/services/attendanceService');

const ME = '44444444-4444-4444-4444-444444444444';
const OTHER = '55555555-5555-5555-5555-555555555555';
const DATE = '2026-11-16';

function serviceWith(rows) {
  return createAttendanceService({
    repositories: { attendance: new AttendanceRepository(rows, []), employees: { async list() { return []; } } },
  });
}

const row = (employeeUid, status) => ({ employeeUid, date: DATE, status });

test('a staff member reads only their own day', async () => {
  const service = serviceWith([row(ME, 'present'), row(OTHER, 'late')]);

  const rows = await service.meDaily({ role: 'EMPLOYEE', employeeUid: ME }, DATE);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeUid, ME);
});

test('a broad role asking this endpoint still gets only their own day', async () => {
  const service = serviceWith([row(ME, 'present'), row(OTHER, 'late')]);

  const rows = await service.meDaily({ role: 'EXECUTIVE', employeeUid: OTHER }, DATE);

  assert.deepEqual(rows.map((entry) => entry.employeeUid), [OTHER],
    'no request parameter can widen the subject');
});

test('a caller with no row that day gets an empty list, not another employee', async () => {
  const service = serviceWith([row(OTHER, 'present')]);

  assert.deepEqual(await service.meDaily({ role: 'EMPLOYEE', employeeUid: ME }, DATE), []);
});

test('a malformed date is refused', async () => {
  const service = serviceWith([]);

  await assert.rejects(
    () => service.meDaily({ role: 'EMPLOYEE', employeeUid: ME }, '16-11-2026'),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
});
