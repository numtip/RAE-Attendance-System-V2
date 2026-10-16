/**
 * Slice 3 integration (fixture repositories, no database): deriving monthly_summary from the stored daily
 * rows, plus the API surface, the scope rules and the staleness check.
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('./helpers/syntheticIdentifierKeys');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createDailyAttendanceService } = require('../src/services/dailyAttendanceService');
const { createMonthlySummaryService } = require('../src/services/monthlySummaryService');
const { createApp } = require('../src/app');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OTHER_UID = '33333333-3333-3333-3333-333333333333';

// March 2026: 31 days, 22 weekdays. The fixture ships AR-0001 approved for the whole of 2026.
const YEAR = 2026;
const MONTH = 3;
const MONDAY = '2026-03-02';

let scanCounter = 0;

async function addScan(repositories, { employeeUid, eventTime, checkType }) {
  scanCounter += 1;
  return repositories.attendanceEvents.insert({
    employeeUid,
    stagingFacescanRawId: 5000 + scanCounter,
    importBatchUid: 'batch-slice3',
    sourceSystem: 'hip_pm2014',
    sourceEventKey: `slice3-${scanCounter}`.padEnd(64, '0'),
    sourceType: 'facescan_checkinout',
    facescanId: 'FS-SLICE3',
    eventTime,
    checkType,
    verifyCode: '1',
    sensorId: 'S1',
    workCode: null,
    timezoneLabel: 'Asia/Bangkok',
  });
}

function services(repositories) {
  return {
    daily: createDailyAttendanceService({ repositories }),
    monthly: createMonthlySummaryService({ repositories }),
  };
}

/**
 * Populate daily rows for a few March days, then derive the month.
 */

async function populateMarch(repositories) {
  const { daily } = services(repositories);
  // Mon 02: late. Tue 03: on time. Wed 04: early departure. Thu 05: no scans (absent).
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 08:00:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 17:00:00', checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 08:30:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 15:30:00', checkType: 'O' });
  return daily.recalculateRange({ employeeUid: USER_UID, from: '2026-03-01', to: '2026-03-06' });
}

test('a month is derived from the stored daily rows, with provenance', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const { monthly } = services(repositories);

  const { stored, diagnosis } = await monthly.recalculateMonth(
    { employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, MONTH,
  );

  assert.equal(diagnosis.dailyRows, 6, 'six rows were derived for Mar 1-6');
  assert.ok(stored, 'a summary was stored');
  assert.equal(stored.employeeUid, USER_UID);
  assert.equal(stored.year, YEAR);
  assert.equal(stored.month, MONTH);
  assert.equal(stored.computationStatus, 'calculated', 'every stored day was judged');
  assert.equal(stored.totalLate, 1, 'Mon 02 was late');
  assert.equal(stored.totalPresent, 2, 'Tue 03 and Wed 04');
  assert.equal(stored.totalAbsent, 2, 'Thu 05 and Fri 06 have no scans on working days');
  assert.equal(stored.totalLateMinutes, 15, '08:45 against an 08:30 threshold');
  assert.equal(stored.totalEarlyMinutes, 60, 'Wed 04 left at 15:30, an hour before the 16:30 threshold');
  assert.equal(stored.totalWorkHours, 23.75, '7.75 (Mon) + 9 (Tue) + 7 (Wed)');
  assert.deepEqual(stored.ruleVersions, ['AR-0001'], 'the approved fixture rule is recorded');
  assert.equal(stored.expectedWorkingDays, 22, 'March 2026 weekdays per the approved Mon-Fri rule');
  assert.equal(stored.sourceKind, 'derived_from_daily_attendance');
  assert.ok(stored.calculatedAt, 'calculated_at is recorded');
  // 22 expected weekdays minus the 5 weekdays that have rows (Mar 1 is a Sunday, so it is not expected).
  assert.equal(stored.dayCounts.missingWorkingDays, 17);
  assert.equal(stored.pendingDays, 0);
  assert.equal(stored.derivationNotes, null);
});

test('derivation is idempotent: one row per employee-month', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const { monthly } = services(repositories);

  const first = await monthly.recalculateMonth({ employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, MONTH);
  const second = await monthly.recalculateMonth({ employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, MONTH);

  // The fixture seeds this employee-month, so the derivation REPLACES that row rather than adding one.
  // Exactly one row per employee-month is the idempotency guarantee.
  assert.equal(repositories.monthlySummaries.all().length, 1, 'one row per employee-month, no duplicate');
  const stripped = (row) => ({ ...row, createdAt: null, updatedAt: null, calculatedAt: null });
  assert.deepEqual(stripped(second.stored), stripped(first.stored), 'the same inputs produce the same month');
});

test('a month with no daily rows is NOT written when it was never derived', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);

  // January has no rows at all, and no stored row exists for it, so it must NOT be written.
  const result = await monthly.recalculate(
    { employeeUid: USER_UID, role: 'admin' },
    { employeeUid: USER_UID, year: YEAR },
  );
  assert.equal(result.summary.monthsWritten, 1, 'only the already-seeded March is refreshed');

  // March had a seed row, so it is refreshed (its sourceKind becomes derived rather than seed). No OTHER
  // month may appear: a phantom zero-month would read as a real month with no attendance.
  const months = repositories.monthlySummaries.all().map((row) => row.month);
  assert.deepEqual(months, [3], 'only March exists, and no empty months were created');
  const january = await repositories.monthlySummaries.findForEmployeeMonth(USER_UID, YEAR, 1);
  assert.equal(january, null, 'an underived month stays absent rather than reading as a month of zeros');
  const march = await repositories.monthlySummaries.findForEmployeeMonth(USER_UID, YEAR, MONTH);
  assert.equal(march.computationStatus, 'no_data', 'March has no daily rows either, and says so');
});

test('an existing month is refreshed to no_data when its daily rows are gone', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);

  // The fixture seeds March for this employee; deriving it with no daily rows must not leave the seed
  // claiming stale figures.
  const before = await repositories.monthlySummaries.findForEmployeeMonth(USER_UID, YEAR, MONTH);
  assert.ok(before, 'the fixture seed row exists');
  await monthly.recalculate({ employeeUid: USER_UID, role: 'admin' }, { employeeUid: USER_UID, year: YEAR, month: MONTH });
  const after = await repositories.monthlySummaries.findForEmployeeMonth(USER_UID, YEAR, MONTH);
  assert.equal(after.computationStatus, 'no_data');
  assert.equal(after.totalPresent, 0, 'the stale seed figures were replaced, not left in place');
  assert.equal(after.sourceKind, 'derived_from_daily_attendance');
});

test('a month containing an unjudged day is partial, and never presented as final', async () => {
  const repositories = createFixtureRepositories();
  const { daily, monthly } = services(repositories);

  // Populate one judged day in 2026, then force an unjudged row directly through the repository: a day the
  // engine could not interpret (two scans with no usable pair).
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  await repositories.dailyAttendance.upsertDay({
    employeeUid: USER_UID,
    date: '2026-03-03',
    checkIn: null,
    checkOut: null,
    isLate: false,
    lateMinutes: 0,
    earlyMinutes: 0,
    workDuration: 0,
    isLeave: false,
    leaveType: null,
    status: 'pending',
    notes: 'synthetic unjudged day',
    sourceSystem: null,
    ruleVersionCode: null,
    scheduleCode: null,
    computationStatus: 'insufficient_data',
    dayClassification: 'workday',
    isOvernight: false,
    sourceEventCount: 1,
    firstEventAt: null,
    lastEventAt: null,
    calculatedAt: '2026-03-03T00:00:00.000Z',
    reconciliationJson: { reason: 'single_scan_only' },
    sourceEventIds: [],
  });

  const { stored } = await monthly.recalculateMonth(
    { employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, MONTH,
  );
  assert.equal(stored.computationStatus, 'partial', 'one unjudged day makes the month partial');
  assert.equal(stored.pendingDays, 1, 'the unjudged day is counted');
  assert.equal(stored.dayCounts.unjudgedDays, 1);
});

test('a 2027 month is pending_policy: the only rule covering it is unapproved', async () => {
  const repositories = createFixtureRepositories();
  const { daily, monthly } = services(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2027-03-01 08:45:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2027-03-01 16:30:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2027-03-01', to: '2027-03-01' });

  const { stored } = await monthly.recalculateMonth(
    { employeeUid: USER_UID, role: 'admin' }, USER_UID, 2027, MONTH,
  );
  assert.equal(stored.computationStatus, 'pending_policy');
  assert.equal(stored.expectedWorkingDays, null, 'no approved calendar, so it is NOT derived');
  assert.match(stored.derivationNotes, /no_approved_rule/);
  assert.equal(stored.totalLate, 0, 'no lateness is claimed from an unapproved rule');
});

test('explain reports whether the stored month is stale', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);
  const auth = { employeeUid: USER_UID, role: 'admin' };
  await populateMarch(repositories);
  await monthly.recalculateMonth(auth, USER_UID, YEAR, MONTH);

  const fresh = await monthly.explain(auth, USER_UID, YEAR, MONTH);
  assert.equal(fresh.stale, false, 'a month that agrees with a fresh derivation is not stale');
  assert.equal(fresh.stored.computationStatus, 'calculated');
  assert.equal(fresh.derived.computationStatus, 'calculated');

  // A new daily row changes the month.
  const { daily } = services(repositories);
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-05 09:00:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-05 17:00:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2026-03-05', to: '2026-03-05' });

  const changed = await monthly.explain(auth, USER_UID, YEAR, MONTH);
  assert.equal(changed.stale, true);
  assert.ok(changed.staleReasons.length > 0);
  assert.ok(changed.staleReasons.includes('derived_values_differ'));
  // Mar 5 already had an `absent` row, so recalculating it UPDATES that row rather than adding one. The
  // row count is therefore unchanged and it is the CONTENT that moved — which is exactly why the staleness
  // check compares derived values and does not rely on the row count or on timestamps.
  assert.equal(changed.derived.dayCounts.rows, fresh.derived.dayCounts.rows);
  assert.equal(changed.derived.totalLate, fresh.derived.totalLate + 1, 'Mar 5 became a late day');
  assert.equal(changed.derived.totalAbsent, fresh.derived.totalAbsent - 1);
});

test('explain reports a month that was never derived', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);
  const result = await monthly.explain({ employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, 7);
  assert.equal(result.stored, null);
  assert.equal(result.stale, true);
  assert.deepEqual(result.staleReasons, ['month_has_never_been_derived']);
  assert.equal(result.derived.computationStatus, 'no_data');
});

// --- regressions found by CI -------------------------------------------------

test('timestamps are compared by instant, not as strings', () => {
  // Caught in CI: a naive wall datetime ('2031-11-03 23:00:00', which a DATETIME column can yield) and an
  // ISO timestamp ('2026-10-16T04:16:45.000Z') do not order lexicographically. Comparing the raw strings
  // made a 2031 wall value look "newer" than a 2026 ISO value purely because '3' > '2' in the year digits,
  // so a freshly derived month was wrongly reported as stale.
  const { toEpochMillis } = require('../src/services/monthlySummaryService');

  assert.ok(toEpochMillis('2031-11-03 23:00:00') > toEpochMillis('2026-10-16T04:16:45.000Z'));
  assert.ok(toEpochMillis('2026-10-16T04:16:45.000Z') > toEpochMillis('2026-10-15 23:00:00'));

  // The naive form must be read as UTC, so the same instant compares EQUAL across the two formats.
  assert.equal(
    toEpochMillis('2026-10-16 04:16:45'),
    toEpochMillis('2026-10-16T04:16:45.000Z'),
  );
  assert.equal(toEpochMillis(new Date('2026-10-16T04:16:45.000Z')), Date.parse('2026-10-16T04:16:45.000Z'));

  // Unparseable values give null so the caller decides, rather than becoming NaN comparisons.
  assert.equal(toEpochMillis(null), null);
  assert.equal(toEpochMillis(''), null);
  assert.equal(toEpochMillis('nonsense'), null);
  assert.equal(toEpochMillis(new Date('invalid')), null);
});

test('a daily computed_at AFTER the month derivation marks the month stale', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);
  const auth = { employeeUid: USER_UID, role: 'admin' };
  await populateMarch(repositories);
  await monthly.recalculateMonth(auth, USER_UID, YEAR, MONTH);

  // Push ONE daily row's timestamp into the future: the month was derived before it, so the month is stale
  // even though its aggregate values are unchanged. This is the secondary signal, and it is legitimate.
  // It must go through the repository — `all()` returns copies, so mutating those would change nothing.
  const monday = await repositories.dailyAttendance.findForEmployeeDate(USER_UID, MONDAY);
  await repositories.dailyAttendance.upsertDay({
    ...monday,
    calculatedAt: '2031-01-01T00:00:00.000Z',
  });

  const explained = await monthly.explain(auth, USER_UID, YEAR, MONTH);
  assert.equal(explained.stale, true);
  assert.ok(explained.staleReasons.includes('daily_rows_changed_after_derivation'));
});

// --- authorization -----------------------------------------------------------

test('scope is enforced on reads, and the organization-wide run needs a broad scope', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);
  const employee = { employeeUid: USER_UID, role: 'user' };
  // The org-wide run only targets employees that HAVE daily rows, so populate them first.
  await populateMarch(repositories);

  await assert.rejects(
    () => monthly.getStored(employee, ADMIN_UID, YEAR, MONTH),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => monthly.listStored(employee, ADMIN_UID, YEAR),
    (error) => error.status === 403,
  );

  // Role alone must not widen data scope: neither a manager nor an admin may rebuild the whole organization
  // without an authorization grant.
  for (const role of ['manager', 'admin']) {
    await assert.rejects(
      () => monthly.recalculate({ employeeUid: ADMIN_UID, role }, { year: YEAR }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
      `${role} must not pass the org-wide guard`,
    );
  }

  // With an org_unit grant the manager holds a broad scope and the run is allowed, restricted to that unit.
  repositories.authorization.grantsFor = async () => [
    { employeeUid: ADMIN_UID, scopeType: 'org_unit', role: 'MANAGER', orgUnitCode: 'DEPT-01' },
  ];
  repositories.authorization.uidsInOrgUnits = async (codes) => (codes.includes('DEPT-01') ? [USER_UID] : []);
  const allowed = await monthly.recalculate(
    { employeeUid: ADMIN_UID, role: 'manager' },
    { year: YEAR, month: MONTH },
  );
  assert.equal(allowed.role, 'MANAGER');
  assert.equal(allowed.summary.employees, 1, 'restricted to the granted unit');
});

test('recalculateMonth rejects an unknown employee and a missing employee', async () => {
  const repositories = createFixtureRepositories();
  const { monthly } = services(repositories);
  await assert.rejects(
    () => monthly.recalculateMonth({ employeeUid: ADMIN_UID, role: 'admin' }, OTHER_UID, YEAR, MONTH),
    (error) => error.status === 403 || error.status === 404,
  );
  await assert.rejects(
    () => monthly.recalculateMonth({ employeeUid: ADMIN_UID, role: 'admin' }, ADMIN_UID, YEAR, MONTH + 99),
    (error) => error.status === 400 && error.code === 'MONTHLY_INVALID_PERIOD',
  );
});

// --- API ---------------------------------------------------------------------

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

test('the monthly summary endpoints are authenticated, scope-bound and never widen on role alone', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const anonymous = await api(port, 'GET', `/api/v1/attendance/monthly-summary/${USER_UID}/${YEAR}/${MONTH}`);
    assert.equal(anonymous.status, 401);

    const user = await login(port, 'user@example.test');
    const admin = await login(port, 'admin@example.test');

    // The seeded March row is visible to its owner.
    const own = await api(port, 'GET', `/api/v1/attendance/monthly-summary/${USER_UID}/${YEAR}/${MONTH}`, {
      token: user.accessToken,
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.totalPresent, 20, 'the fixture seed, unchanged');

    const crossEmployee = await api(port, 'GET', `/api/v1/attendance/monthly-summary/${ADMIN_UID}/${YEAR}/${MONTH}`, {
      token: user.accessToken,
    });
    assert.equal(crossEmployee.status, 403);
    assert.equal(crossEmployee.body.error.code, 'FORBIDDEN');

    const yearList = await api(port, 'GET', `/api/v1/attendance/monthly-summary/${USER_UID}/${YEAR}`, {
      token: user.accessToken,
    });
    assert.equal(yearList.status, 200);
    assert.equal(Array.isArray(yearList.body.data), true);

    // A plain user cannot derive anything.
    const userDerive = await api(port, 'POST', `/api/v1/attendance/monthly-summary/recalculate/${USER_UID}/${YEAR}/${MONTH}`, {
      token: user.accessToken,
    });
    assert.equal(userDerive.status, 403);

    // An admin may derive their OWN month.
    const adminDerive = await api(port, 'POST', `/api/v1/attendance/monthly-summary/recalculate/${ADMIN_UID}/${YEAR}/${MONTH}`, {
      token: admin.accessToken,
    });
    assert.equal(adminDerive.status, 200);

    // But not the whole organization by omitting the employee: 403, not a silent full-org rebuild.
    const orgWide = await api(port, 'POST', '/api/v1/attendance/monthly-summary/recalculate', {
      token: admin.accessToken,
      body: { year: YEAR },
    });
    assert.equal(orgWide.status, 403);
    assert.equal(orgWide.body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('explain is exposed and reports the pending policy for 2027', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const user = await login(port, 'user@example.test');
    const explained = await api(port, 'GET', `/api/v1/attendance/monthly-summary-explain/${USER_UID}/2027/3`, {
      token: user.accessToken,
    });
    assert.equal(explained.status, 200);
    assert.equal(explained.body.data.derived.computationStatus, 'no_data');
    assert.equal(explained.body.data.stale, true);
    assert.equal(JSON.stringify(explained.body.data).includes('passwordHash'), false);
  } finally {
    server.close();
  }
});
