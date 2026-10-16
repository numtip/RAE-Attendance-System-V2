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

test('the shipped fixture carries an approved rule for 2026 and an unapproved successor for 2027', () => {
  const seeded = fixtures.attendanceRuleVersions;
  assert.equal(seeded.length, 2);

  const approved = seeded.find((row) => row.ruleVersionCode === 'AR-0001');
  // OWNER DECISION 2026-10-16: these values are approved. The DB CHECK requires an approver, so assert it.
  assert.equal(approved.status, 'approved');
  assert.equal(approved.effectiveFrom, '2026-01-01');
  assert.equal(approved.effectiveTo, '2026-12-31');
  assert.ok(approved.approvedBy, 'an approved rule must name an approver');
  assert.ok(approved.approvedAt, 'an approved rule must carry a timestamp');
  assert.deepEqual(approved.workDays, [1, 2, 3, 4, 5]);

  // The gate stays demonstrable: the only rule covering 2027 is NOT approved.
  const successor = seeded.find((row) => row.ruleVersionCode === 'AR-0002');
  assert.equal(successor.status, 'pending_approval');
  assert.equal(successor.approvedBy, null);
  assert.ok(successor.effectiveFrom >= '2027-01-01');
});

test('an unapproved rule yields pending_policy end to end, then a real result once approved', async () => {
  const repositories = createFixtureRepositories();
  const service = serviceWith(repositories);

  // A 2027 date, where the ONLY rule covering it (AR-0002) is still pending_approval.
  const PENDING_DAY = '2027-03-01'; // a Monday
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${PENDING_DAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${PENDING_DAY} 16:30:00`, checkType: 'O' });

  const before = await service.recalculateRange({ employeeUid: USER_UID, from: PENDING_DAY, to: PENDING_DAY });
  assert.equal(before.summary.pendingPolicy, 1);
  const pendingRow = before.days[0];
  assert.equal(pendingRow.computationStatus, 'pending_policy');
  assert.equal(pendingRow.status, 'pending');
  assert.equal(pendingRow.lateMinutes, 0, 'no lateness may be produced from an unapproved rule');
  assert.equal(pendingRow.ruleVersionCode, null, 'an unapproved rule must not be recorded as the rule used');

  // Now approve a rule covering that date, and the same scans produce a real calculation.
  await repositories.attendanceRules.insertRuleVersion({ ...APPROVED_RULE, effectiveFrom: '2027-01-01' });
  const after = await service.recalculateRange({ employeeUid: USER_UID, from: PENDING_DAY, to: PENDING_DAY });
  assert.equal(after.summary.calculated, 1);

  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, PENDING_DAY);
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

// --- regressions found by independent verification ---------------------------

test('a Date-shaped eventTime is grouped by its wall date, not by String(Date)', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);

  // MariaDB hands back a JS Date for the event_time DATETIME. `String(date).slice(0, 10)` yields
  // "Mon Mar 02", which matched no ISO date and silently produced an `absent` row with zero provenance.
  await addScan(repositories, {
    employeeUid: USER_UID, eventTime: new Date('2026-03-02T08:45:00.000Z'), checkType: 'I',
  });
  await addScan(repositories, {
    employeeUid: USER_UID, eventTime: new Date('2026-03-02T16:30:00.000Z'), checkType: 'O',
  });

  const result = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  assert.equal(result.summary.calculated, 1);
  assert.equal(result.summary.noData, 0, 'the scans must not be lost');
  const stored = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);
  assert.equal(stored.status, 'late');
  assert.equal(stored.lateMinutes, 15);
  assert.equal(stored.sourceEventCount, 2, 'provenance survives a Date-shaped timestamp');
  assert.equal(stored.sourceEventIds.length, 2);
  assert.equal(stored.checkIn, `${MONDAY} 08:45:00`);
});

test('groupEventsByDate reads a Date and a string to the same day', () => {
  const { groupEventsByDate } = require('../src/services/dailyAttendanceService');
  const grouped = groupEventsByDate([
    { id: 1, eventTime: new Date('2026-03-02T08:45:00.000Z') },
    { id: 2, eventTime: '2026-03-02 16:30:00' },
    { id: 3, eventTime: new Date('2026-03-03T06:00:00.000Z') },
    { id: 4, eventTime: 'not-a-timestamp' },
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ['2026-03-02', '2026-03-03']);
  assert.equal(grouped.get('2026-03-02').length, 2, 'a Date and a string land in the same bucket');
  assert.equal(grouped.get('2026-03-03').length, 1);
});

test('an overnight shift is reachable through the service, not only the pure engine', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion({ ...APPROVED_RULE, overnightShift: true });
  const service = serviceWith(repositories);

  // 22:00 on Monday, 06:00 on Tuesday.
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 22:00:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 06:00:00', checkType: 'O' });

  const result = await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  const monday = result.days[0];
  assert.equal(monday.computationStatus, 'calculated');
  assert.equal(monday.isOvernight, true);
  assert.equal(monday.workDuration, 8, 'the night shift span is reachable end to end');
  assert.equal(monday.lateMinutes, 0);
  assert.equal(monday.reconciliationJson.overnightLatenessPolicyMissing, true);
  assert.deepEqual(monday.sourceEventIds, [1, 2]);
  // Only the requested day is written: Tuesday has no row, so the shift cannot be counted twice.
  const tuesday = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, '2026-03-03');
  assert.equal(tuesday, null);
});

test('an organization-wide recalculation requires a broad data scope', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });

  // A manager with no grant, and an admin, must NOT be able to rebuild (or read back) every employee just
  // by omitting employeeUid. Role alone does not widen data scope.
  await assert.rejects(
    () => service.recalculate({ employeeUid: ADMIN_UID, role: 'manager' }, { from: MONDAY, to: MONDAY }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => service.recalculate({ employeeUid: ADMIN_UID, role: 'admin' }, { from: MONDAY, to: MONDAY }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  // The narrow, own-scope path still works.
  const own = await service.recalculate(
    { employeeUid: ADMIN_UID, role: 'admin' },
    { employeeUid: ADMIN_UID, from: MONDAY, to: MONDAY },
  );
  assert.equal(own.summary.dates, 1);
});

test('a broad scope may run an organization-wide recalculation', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  // A MANAGER holding an org_unit grant resolves to a broad data scope (an EXECUTIVE is deliberately
  // read-only for this operation, so it is not the right actor for a rebuild).
  repositories.authorization.grantsFor = async () => [
    { employeeUid: ADMIN_UID, scopeType: 'org_unit', role: 'MANAGER', orgUnitCode: 'DEPT-01' },
  ];
  repositories.authorization.uidsInOrgUnits = async (codes) => (codes.includes('DEPT-01') ? [USER_UID] : []);
  const service = serviceWith(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });

  const result = await service.recalculate(
    { employeeUid: ADMIN_UID, role: 'manager' },
    { from: MONDAY, to: MONDAY },
  );
  assert.equal(result.summary.employees, 1, 'the one employee inside the granted unit was rebuilt');
  assert.equal(result.summary.calculated, 1);
  assert.equal(result.role, 'MANAGER');
});

test('an executive with a broad grant is read-only for recalculation', async () => {
  const repositories = createFixtureRepositories();
  repositories.authorization.grantsFor = async () => [
    { employeeUid: ADMIN_UID, scopeType: 'organization', role: 'EXECUTIVE' },
  ];
  const service = serviceWith(repositories);
  await assert.rejects(
    () => service.recalculate({ employeeUid: ADMIN_UID, role: 'EXECUTIVE' }, { from: MONDAY, to: MONDAY }),
    (error) => error.status === 403,
  );
});

test('explain reports stale from the decision, not from the timestamp', async () => {
  const repositories = createFixtureRepositories();
  await repositories.attendanceRules.insertRuleVersion(APPROVED_RULE);
  const service = serviceWith(repositories);
  const auth = { employeeUid: USER_UID, role: 'user' };
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await service.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });

  const fresh = await service.explain(auth, USER_UID, MONDAY);
  assert.equal(fresh.stale, false, 'a row that agrees with a fresh calculation is not stale');

  // A new scan changes the decision, so the stored row is genuinely stale.
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 18:00:00`, checkType: 'O' });
  const changed = await service.explain(auth, USER_UID, MONDAY);
  assert.equal(changed.stale, true);
  assert.ok(changed.calculation.workDuration > fresh.calculation.workDuration);
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

    // An organization-wide rebuild (no employeeUid) requires a BROAD data scope. An admin holds no
    // authorization grant here, so role alone must not be enough: 403, not a silent full-org rebuild.
    const unscopedRecalc = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: admin.accessToken,
      body: { from: MONDAY, to: MONDAY },
    });
    assert.equal(unscopedRecalc.status, 403);
    assert.equal(unscopedRecalc.body.error.code, 'FORBIDDEN');

    // The fixture ships an approved rule for 2026, so 2026-03-02 is now JUDGED. This admin has no scans on
    // that date, so the day is a real absence: day-level `no_data` with status `absent`, which counts in
    // `noData`, not `calculated`. Nothing may be claimed as pending_policy any more.
    const adminRecalc = await api(port, 'POST', '/api/v1/attendance/recalculate', {
      token: admin.accessToken,
      body: { employeeUid: ADMIN_UID, from: MONDAY, to: MONDAY },
    });
    assert.equal(adminRecalc.status, 200);
    assert.equal(adminRecalc.body.data.summary.pendingPolicy, 0);
    assert.equal(adminRecalc.body.data.summary.calculated, 0);
    assert.equal(adminRecalc.body.data.summary.noData, 1);
    assert.equal(adminRecalc.body.data.days[0].status, 'absent');
    assert.equal(adminRecalc.body.data.advisory.available, false);

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
    // 2027: the only rule covering it is the unapproved successor AR-0002.
    const explained = await api(port, 'GET', `/api/v1/attendance/explain/${USER_UID}/2027-03-01`, {
      token: user.accessToken,
    });
    assert.equal(explained.status, 200);
    const diagnosis = explained.body.data.diagnosis;
    assert.equal(diagnosis.computationStatus, 'pending_policy');
    assert.equal(diagnosis.rulePending.ruleVersionCode, 'AR-0002');
    assert.equal(diagnosis.rulePending.status, 'pending_approval');
    assert.equal(JSON.stringify(diagnosis).includes('passwordHash'), false);
  } finally {
    server.close();
  }
});
