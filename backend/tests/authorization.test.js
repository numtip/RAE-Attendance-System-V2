const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createEmployeeService } = require('../src/services/employeeService');
const { createAttendanceService } = require('../src/services/attendanceService');
const { createLeaveService } = require('../src/services/leaveService');

const adminUid = '11111111-1111-1111-1111-111111111111';
const userUid = '22222222-2222-2222-2222-222222222222';
const otherUid = '33333333-3333-3333-3333-333333333333';

function withScope(grants, memberships) {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(employeeUid) {
      return grants.filter((grant) => grant.employeeUid === employeeUid);
    },
    async uidsInOrgUnits(codes) {
      const allowed = new Set(codes);
      return memberships.filter((row) => allowed.has(row.orgUnitCode)).map((row) => row.employeeUid);
    },
  };
  return {
    employees: createEmployeeService({ repositories }),
    attendance: createAttendanceService({ repositories }),
    leave: createLeaveService({ repositories }),
  };
}

test('EMPLOYEE sees only self and cannot switch employee_id', async () => {
  const api = withScope([], []);
  const auth = { role: 'EMPLOYEE', employeeUid: userUid };
  const list = await api.employees.list(auth);
  assert.deepEqual(list.map((row) => row.employeeUid), [userUid]);
  await assert.rejects(
    () => api.employees.getByUid(auth, adminUid),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => api.employees.getByUid(auth, userUid, 'E-ADMIN'),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => api.attendance.monthly(auth, otherUid, 2026, 3),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => api.leave.history(auth, adminUid),
    (err) => err.status === 403,
  );
});

test('MANAGER without an evidenced org unit is limited to self', async () => {
  const api = withScope([], []);
  const auth = { role: 'MANAGER', employeeUid: adminUid };
  await assert.rejects(
    () => api.attendance.daily(auth, '2026-03-02'),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => api.attendance.monthly(auth, userUid, 2026, 3),
    (err) => err.status === 403,
  );
});

test('MANAGER sees members of granted org unit codes only', async () => {
  const api = withScope(
    [{ employeeUid: adminUid, role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'OU-SYN-1' }],
    [
      { employeeUid: userUid, orgUnitCode: 'OU-SYN-1' },
      { employeeUid: otherUid, orgUnitCode: 'OU-SYN-2' },
    ],
  );
  const auth = { role: 'MANAGER', employeeUid: adminUid };
  const monthly = await api.attendance.monthly(auth, userUid, 2026, 3);
  assert.equal(monthly.totalPresent, 20);
  await assert.rejects(
    () => api.leave.balance(auth, otherUid, 2026),
    (err) => err.status === 403,
  );
  const daily = await api.attendance.daily(auth, '2026-03-02');
  assert.equal(daily.length, 1);
  assert.equal(daily[0].employeeUid, userUid);
});

test('EXECUTIVE without an organization grant is not organization-wide', async () => {
  const api = withScope([], []);
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };
  await assert.rejects(
    () => api.attendance.daily(auth, '2026-03-02'),
    (err) => err.status === 403,
  );
});

test('EXECUTIVE with an organization grant can read attendance and leave', async () => {
  const api = withScope(
    [{ employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization', orgUnitCode: null }],
    [],
  );
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };
  const daily = await api.attendance.daily(auth, '2026-03-02');
  assert.equal(daily.length, 1);
  const history = await api.leave.history(auth, userUid);
  assert.equal(history[0].leaveId, 'LV-1');
});

test('ADMIN has directory access and does not inherit executive data scope', async () => {
  const api = withScope([], []);
  const auth = { role: 'admin', employeeUid: adminUid };
  const list = await api.employees.list(auth);
  assert.equal(list.length, 3);
  await assert.rejects(
    () => api.attendance.daily(auth, '2026-03-02'),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => api.leave.history(auth, userUid),
    (err) => err.status === 403,
  );
});
