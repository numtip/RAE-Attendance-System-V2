/**
 * Slice 2 integration (fixture repositories, no database): the whole chain from a normalized scan to a
 * stored, provenance-carrying daily_attendance row, plus the API surface and the Agent Core boundary.
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('./helpers/syntheticIdentifierKeys');

const fixtures = require('../src/dev/fixtures');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createDailyAttendanceService } = require('../src/services/dailyAttendanceService');
const { createApp } = require('../src/app');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

// 2026-03-02 is a Monday; 2026-03-07 a Saturday; 2026-03-10 a Tuesday.
const MONDAY = '2026-03-02';
const SATURDAY = '2026-03-07';
const LEAVE_TUESDAY = '2026-03-10';

const APPROVED_RULE = {
  ruleVersionCode: 'AR-TEST-1',
  name: 'Synthetic approved rule',
  status: 'approved',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  workStart: '08:30:00',
  workEnd: '16:30:00',
  lateAfter: '08:30:00',
  earlyBefore: '16:30:00',
  workDays: [1, 2, 3, 4, 5],
  approvedBy: 'operator:synthetic',
  approvedAt: '2026-01-01T00:00:00.000Z',
};

let eventCounter = 0;

async function addScan(repositories, { employeeUid, eventTime, checkType }) {
  eventCounter += 1;
  return repositories.attendanceEvents.insert({
    employeeUid,
    stagingFacescanRawId: 1000 + eventCounter,
    importBatchUid: 'batch-synthetic-1',
    sourceSystem: 'hip_pm2014',
    sourceEventKey: `key-${eventCounter}`.padEnd(64, '0'),
    sourceType: 'facescan_checkinout',
    facescanId: 'FS-USER-001',
    eventTime,
    checkType,
    verifyCode: '1',
    sensorId: 'S1',
    workCode: null,
    timezoneLabel: 'Asia/Bangkok',
  });
}

function serviceWith(repositories, agentAdvisory = null) {
  return createDailyAttendanceService({ repositories, agentAdvisory });
}

test('the shipped fixture rule is pending, so nothing is silently assumed', () => {
  const seeded = fixtures.attendanceRuleVersions;
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].status, 'pending_approval');
  assert.notEqual(seeded[0].status, 'approved');
});

test('an unapproved rule yields pending_policy end to end, then a real result once approved', async () => {
  const repositories = createFixtureRepositories();
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });

  // 1. Only the seeded pending_approval rule exists.
  const before = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  assert.equal(before.summary.pendingPolicy, 1);
  const pendingRow = before.days[0];
  assert.equal(pendingRow.computationStatus, 'pending_policy');
  assert.equal(pendingRow.status, 'pending');
  assert.equal(pendingRow.lateMinutes, 0, 'no lateness may be produced from an unapproved rule');
  assert.equal(pendingRow.ruleVersionCode, null, 'an unapproved rule must not be recorded as the rule used');

  // 2. Approve it, and the same scans now produce a real calculation.
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const after = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  assert.equal(after.summary.calculated, 1);

  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);
  assert.equal(stored.computationStatus, 'calculated');
  assert.equal(stored.status, 'late');
  assert.equal(stored.lateMinutes, 15);
  assert.equal(stored.workDuration, 7.75);
  assert.equal(stored.ruleVersionCode, 'AR-TEST-1');
  assert.equal(stored.dayClassification, 'workday');
  assert.equal(stored.sourceEventCount, 2);
  assert.equal(stored.sourceSystem, 'hip_pm2014');
});

test('the stored row carries rule version, source event ids, status and reconciliation', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);

  const inScan = await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:00:00`, checkType: 'I' });
  const outScan = await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 17:00:00`, checkType: 'O' });

  await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);

  assert.equal(stored.ruleVersionCode, 'AR-TEST-1');
  assert.deepEqual(stored.sourceEventIds, [inScan.id, outScan.id]);
  assert.equal(stored.reconciliationJson.ruleVersionCode, 'AR-TEST-1');
  assert.equal(stored.reconciliationJson.reason, 'calculated_from_scans');
  assert.ok(stored.calculatedAt, 'calculated_at is recorded');
  assert.equal(stored.firstEventAt, `${MONDAY} 08:00:00`);
  assert.equal(stored.lastEventAt, `${MONDAY} 17:00:00`);
});

test('recalculation is idempotent and deterministic', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:00:00`, checkType: 'O' });

  const first = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  const second = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });

  assert.equal(repositories.dailyAttendance.all().rows.length, 1, 'one row per employee-day');
  // calculatedAt and updatedAt legitimately move on a rewrite; every decision and number must not.
  const strip = (row) => ({ ...row, calculatedAt: null, updatedAt: null });
  assert.deepEqual(strip(second.days[0]), strip(first.days[0]), 'the same inputs must produce the same numbers');
  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);
  assert.deepEqual(stored.sourceEventIds, first.days[0].sourceEventIds, 'the link set is replaced, not duplicated');
  const links = repositories.dailyAttendance.all().links;
  assert.equal(links.length, 2, 'the two links are not duplicated by the second run');
});

test('a holiday and a weekend are not judged, and verified leave is recorded as leave', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  await repositories.attendanceRules.insertHoliday({
    holidayDate: MONDAY,
    name: 'Synthetic Holiday',
    scope: 'university',
    status: 'approved',
    sourceSystem: 'synthetic',
    approvedBy: 'operator:synthetic',
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const service = serviceWith(repositories);

  const holiday = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  assert.equal(holiday.days[0].dayClassification, 'holiday');
  assert.equal(holiday.days[0].status, 'holiday');
  assert.equal(holiday.days[0].lateMinutes, 0);

  const weekend = await service.recalculateRange({ employeeUid: USER_UID, from: SATURDAY, to: SATURDAY });
  assert.equal(weekend.days[0].dayClassification, 'weekend');
  assert.equal(weekend.days[0].status, 'holiday');

  // The fixture ships one verified personal-leave row dated 2026-03-10.
  const leave = await service.recalculateRange({ employeeUid: USER_UID, from: LEAVE_TUESDAY, to: LEAVE_TUESDAY });
  assert.equal(leave.days[0].status, 'leave');
  assert.equal(leave.days[0].isLeave, true);
  assert.equal(leave.days[0].leaveType, 'personal');
});

test('a range recalculation covers several days and never aborts on one bad day', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:00:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 17:00:00`, checkType: 'O' });

  const result = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: '2026-03-08' });
  assert.equal(result.summary.dates, 7, 'Mon..Sun inclusive');
  // Only the day with scans is evaluated: Mon = late. Tue-Fri have no scans and no leave, so they are a
  // real absence (`no_data`), and the two weekend days are `calculated` as non-working days.
  assert.equal(result.summary.calculated, 3, 'Mon plus the two weekend days');
  assert.equal(result.summary.noData, 4, 'Tue-Fri with no scans');
  assert.equal(result.summary.failed, 0);
  assert.equal(result.days.length, 7);
  // Friday 2026-03-06 is a workday with no scans and no leave -> a real absence.
  const friday = result.days.find((row) => row.date === '2026-03-06');
  assert.equal(friday.status, 'absent');
  assert.equal(friday.computationStatus, 'no_data');
  const monday = result.days.find((row) => row.date === MONDAY);
  assert.equal(monday.computationStatus, 'calculated');
  assert.equal(monday.status, 'present', '08:00 is not late against an 08:30 threshold');
});

test('an Agent Core outage never blocks or alters a calculation', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });

  const failingAdvisory = {
    available: true,
    async evaluate() {
      const error = new Error('Agent Core is unreachable');
      error.code = 'AGENT_CORE_UNAVAILABLE';
      throw error;
    },
  };
  const service = serviceWith(repositories, failingAdvisory);
  const result = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  assert.equal(result.summary.calculated, 1, 'the calculation still happened');

  const advisory = await service.requestAdvisory({ summary: result.summary });
  assert.equal(advisory.available, false);
  assert.equal(advisory.reason, 'agent_advisory_unavailable');
  assert.equal(advisory.code, 'AGENT_CORE_UNAVAILABLE');

  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);
  assert.equal(stored.lateMinutes, 15, 'the advisory plane cannot change a number');
});

test('with no advisory configured the service reports that plainly', async () => {
  const repositories = createFixtureRepositories();
  const service = serviceWith(repositories);
  const advisory = await service.requestAdvisory({ summary: { calculated: 0 } });
  assert.equal(advisory.available, false);
  assert.equal(advisory.reason, 'agent_advisory_not_configured');
});

test('explain returns the calculation, the stored row and whether it is stale', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });

  const auth = { employeeUid: USER_UID, role: 'user' };
  const explained = await service.explain(auth, USER_UID, MONDAY);
  assert.equal(explained.diagnosis.computationStatus, 'calculated');
  assert.equal(explained.calculation.lateMinutes, 15);
  assert.ok(explained.stored, 'the stored row is returned');
  assert.equal(explained.diagnosis.ruleVersionCode, 'AR-TEST-1');
  assert.equal(JSON.stringify(explained.diagnosis).includes('passwordHash'), false);
});

test('scope is enforced on reads and recalculation', async () => {
  const repositories = createFixtureRepositories();
  const service = serviceWith(repositories);
  const employee = { employeeUid: USER_UID, role: 'user' };

  await assert.rejects(
    () => service.getStored(employee, ADMIN_UID, MONDAY),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => service.recalculate(employee, { employeeUid: ADMIN_UID, from: MONDAY, to: MONDAY }),
    (error) => error.status === 403,
  );
  // An employee may read their own stored day.
  assert.equal(await service.getStored(employee, USER_UID, MONDAY), null);
});

test('recalculateRange rejects an inverted or malformed range', async () => {
  const repositories = createFixtureRepositories();
  const service = serviceWith(repositories);
  await assert.rejects(
    () => service.recalculateRange({ employeeUid: USER_UID, from: '2026-03-10', to: '2026-03-01' }),
    (error) => error.status === 400 && error.code === 'DAILY_CALC_INVALID_RANGE',
  );
  await assert.rejects(
    () => service.recalculateRange({ employeeUid: USER_UID, from: 'nope', to: '2026-03-01' }),
    (error) => error.status === 400,
  );
});

// --- API -------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function api(port, method, path, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function login(port, email) {
  const response = await api(port, 'POST', '/api/v1/auth/login', { body: { email, password: 'valid-pass' } });
  assert.equal(response.status, 200);
  return response.body.data;
}

test('the calculation endpoints are authenticated and scope-bound', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const anonymous = await api(port, 'GET', `/api/v1/attendance/daily-computed/${USER_UID}/${MONDAY}`);
    assert.equal(anonymous.status, 401);

    const user = await login(port, 'user@example.test');
    const admin = await login(port, 'admin@example.test');

    const own = await api(port, 'GET', `/api/v1/attendance/daily-computed/${USER_UID}/${MONDAY}`, {
      token: user.accessToken,
    });
    assert.equal(own.status, 200);

    const otherPerson = await api(port, 'GET', `/api/v1/attendance/daily-computed/${ADMIN_UID}/${MONDAY}`, {
      token: user.accessToken,
    });
    assert.equal(otherPerson.status, 403);
    assert.equal(otherPerson.body.error.code, 'FORBIDDEN');

    // A plain user may not trigger a recalculation at all.
    const userRecalc = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: user.accessToken,
      body: { from: MONDAY, to: MONDAY },
    });
    assert.equal(userRecalc.status, 403);

    // An unscoped range has no employees WITH SCANS to rebuild, so it is a no-op rather than a full scan of
    // every employee in the table.
    const unscopedRecalc = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: admin.accessToken,
      body: { from: MONDAY, to: MONDAY },
    });
    assert.equal(unscopedRecalc.status, 200);
    assert.equal(unscopedRecalc.body.data.summary.employees, 0);
    assert.equal(unscopedRecalc.body.data.summary.dates, 0);

    // An admin may recalculate their OWN record. Fixture mode ships a pending rule only, so the outcome is
    // pending_policy: nothing may be claimed as calculated.
    const adminRecalc = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: admin.accessToken,
      body: { employeeUid: ADMIN_UID, from: MONDAY, to: MONDAY },
    });
    assert.equal(adminRecalc.status, 200);
    assert.equal(adminRecalc.body.data.summary.calculated, 0);
    assert.equal(adminRecalc.body.data.summary.pendingPolicy, 1);
    assert.equal(adminRecalc.body.data.advisory.available, false);
    assert.equal(adminRecalc.body.data.days[0].status, 'pending');

    // Another employee's record is out of scope for an admin as well: broad data access needs an explicit
    // authorization grant, which role alone must not confer.
    const crossEmployee = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: admin.accessToken,
      body: { employeeUid: USER_UID, from: MONDAY, to: MONDAY },
    });
    assert.equal(crossEmployee.status, 403);
    assert.equal(crossEmployee.body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('the explain endpoint reports why a day is pending', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const user = await login(port, 'user@example.test');
    const explained = await api(port, 'GET', `/api/v1/attendance/explain/${USER_UID}/${MONDAY}`, {
      token: user.accessToken,
    });
    assert.equal(explained.status, 200);
    const diagnosis = explained.body.data.diagnosis;
    assert.equal(diagnosis.computationStatus, 'pending_policy');
    assert.equal(diagnosis.rulePending.status, 'pending_approval');
    assert.equal(JSON.stringify(diagnosis).includes('passwordHash'), false);
  } finally {
    server.close();
  }
});
