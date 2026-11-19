const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createAttendanceComputeService, MAX_PERIOD_DAYS } = require('../src/services/attendanceComputeService');

const operatorUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222'; // E-USER
const otherCode = 'E-LOCKED'; // a different fixture employee, outside a manager's org unit

function build({ role, grants = [], members = [] }) {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(uid) { return uid === operatorUid ? grants : []; },
    async uidsInOrgUnits() { return members; },
  };
  const calls = [];
  const service = createAttendanceComputeService({
    repositories,
    coreClient: {
      async evaluateDay(payload) { calls.push('day'); return { employee_id: payload.employee_id, date: payload.date, attendance_status: 'PRESENT', issues: [] }; },
      async evaluatePeriod() { calls.push('period'); return { ok: true }; },
    },
  });
  return { service, calls, auth: { role, employeeUid: operatorUid } };
}
const day = (employee_id, date = '2026-08-03') => ({ employee_id, date, check_in: '08:00:00', check_out: '16:30:00' });

test('compute: a raw admin or manager role with no grant is refused', async () => {
  for (const role of ['admin', 'manager', 'user']) {
    const { service, calls, auth } = build({ role });
    await assert.rejects(service.evaluateDay(auth, day('E-USER')), (error) => error.status === 403, role);
    await assert.rejects(service.evaluatePeriod(auth, { days: [day('E-USER')] }), (error) => error.status === 403, role);
    assert.deepEqual(calls, [], 'the core is never reached');
  }
});

test('compute: an organization executive may evaluate any employee', async () => {
  const { service, auth } = build({ role: 'executive', grants: [{ employeeUid: operatorUid, role: 'EXECUTIVE', scopeType: 'organization' }] });
  assert.equal((await service.evaluateDay(auth, day('E-USER'))).employeeUid, staffUid);
  assert.equal((await service.evaluateDay(auth, day(otherCode))).attendance_status, 'PRESENT');
});

test('compute: a manager is limited to their org unit, for a day and for a period', async () => {
  const { service, calls, auth } = build({
    role: 'manager',
    grants: [{ employeeUid: operatorUid, role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }],
    members: [staffUid],
  });
  assert.equal((await service.evaluateDay(auth, day('E-USER'))).employeeUid, staffUid);
  await assert.rejects(service.evaluateDay(auth, day(otherCode)), (error) => error.status === 403);
  const before = calls.length;
  await assert.rejects(
    service.evaluatePeriod(auth, { days: [day('E-USER'), day(otherCode)] }),
    (error) => error.status === 403,
  );
  assert.equal(calls.length, before, 'one out-of-scope day refuses the whole period before the core is called');
});

test('compute: a period is bounded to one month of days', async () => {
  const { service, auth } = build({ role: 'executive', grants: [{ employeeUid: operatorUid, role: 'EXECUTIVE', scopeType: 'organization' }] });
  const tooMany = Array.from({ length: MAX_PERIOD_DAYS + 1 }, (_, index) => day('E-USER', `2026-08-${String((index % 28) + 1).padStart(2, '0')}`));
  await assert.rejects(service.evaluatePeriod(auth, { days: tooMany }), (error) => error.status === 400);
  assert.deepEqual(await service.evaluatePeriod(auth, { days: tooMany.slice(0, MAX_PERIOD_DAYS) }), { ok: true });
});

test('compute: without repositories there is no scope to check, so it fails closed', async () => {
  const service = createAttendanceComputeService({ coreClient: { async evaluateDay() { throw new Error('must not be reached'); } } });
  await assert.rejects(service.evaluateDay({ role: 'admin', employeeUid: operatorUid }, day('E-USER')), (error) => error.status === 503);
});
