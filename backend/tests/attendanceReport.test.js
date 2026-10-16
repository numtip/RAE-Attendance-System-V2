/**
 * R-02 individual attendance reports (fixture repositories, no database).
 *
 * The point of this suite is the HONESTY contract, not the arithmetic: every report must name its rule
 * version, date cutoff and population, and a `partial` / `pending_policy` / never-derived month must never
 * come back looking like a final figure.
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
const { createAttendanceReportService } = require('../src/services/attendanceReportService');
const {
  REPORT_KIND,
  REPORT_CAVEAT,
  academicYearPeriod,
  isFinalStatus,
  verdictOf,
} = require('../src/domain/attendanceReport');
const { createApp } = require('../src/app');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

const YEAR = 2026;
const MONTH = 3;
const MONDAY = '2026-03-02'; // a Monday
const JUNE_2026 = '2026-06-01'; // also a Monday

let scanCounter = 0;

async function addScan(repositories, { employeeUid, eventTime, checkType }) {
  scanCounter += 1;
  return repositories.attendanceEvents.insert({
    employeeUid,
    stagingFacescanRawId: 7000 + scanCounter,
    importBatchUid: 'batch-report',
    sourceSystem: 'hip_pm2014',
    sourceEventKey: `report-${scanCounter}`.padEnd(64, '0'),
    sourceType: 'facescan_checkinout',
    facescanId: 'FS-REPORT',
    eventTime,
    checkType,
    verifyCode: '1',
    sensorId: 'S1',
    workCode: null,
    timezoneLabel: 'Asia/Bangkok',
  });
}

/** A stored day row that bypasses the engine, for the cases the engine would not produce on its own. */
function dayRow(overrides = {}) {
  return {
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
    notes: 'synthetic',
    sourceSystem: null,
    ruleVersionCode: 'AR-0001',
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
    ...overrides,
  };
}

/** Populate and derive March 2026: Mon late, Tue on time, Wed early, Thu/Fri absent, Sun non-working. */
async function populateMarch(repositories) {
  const daily = createDailyAttendanceService({ repositories });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 08:00:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-03 17:00:00', checkType: 'O' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 08:30:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2026-03-04 15:30:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2026-03-01', to: '2026-03-06' });
  return createMonthlySummaryService({ repositories }).recalculateMonth(
    { employeeUid: USER_UID, role: 'admin' }, USER_UID, YEAR, MONTH,
  );
}

/** A monthly_summary row in the repository's own shape, for years the engine has nothing to derive. */
async function seedMonth(repositories, {
  year, month, computationStatus = 'calculated', expectedWorkingDays = 22, dayCounts = null,
} = {}) {
  return repositories.monthlySummaries.upsertMonth({
    employeeUid: USER_UID,
    year,
    month,
    totalWorkDays: 20,
    totalPresent: 18,
    totalLate: 1,
    totalAbsent: 1,
    totalLeave: 0,
    totalLateMinutes: 5,
    totalEarlyMinutes: 0,
    totalWorkHours: 140,
    pendingDays: 0,
    holidayDays: 0,
    expectedWorkingDays,
    computationStatus,
    ruleVersions: ['AR-0001'],
    dayCounts: dayCounts ?? { rows: 20, unjudgedDays: computationStatus === 'calculated' ? 0 : 1 },
    derivationNotes: null,
    calculatedAt: '2026-06-30T00:00:00.000Z',
  });
}

function reportService(repositories, now = () => new Date()) {
  return createAttendanceReportService({ repositories, now });
}

const ADMIN_AUTH = { employeeUid: USER_UID, role: 'admin' };

// --- the domain contract -----------------------------------------------------

test('the verdict rules are explicit about what counts as final', () => {
  // A day-level absence is a CONCLUSION (DECISIONS.md E24); a month's absence of data is not.
  assert.equal(isFinalStatus(REPORT_KIND.DAY, 'calculated'), true);
  assert.equal(isFinalStatus(REPORT_KIND.DAY, 'no_data'), true);
  assert.equal(isFinalStatus(REPORT_KIND.DAY, 'insufficient_data'), false);
  assert.equal(isFinalStatus(REPORT_KIND.DAY, 'pending_policy'), false);

  assert.equal(isFinalStatus(REPORT_KIND.MONTH, 'calculated'), true);
  for (const status of ['partial', 'pending_policy', 'no_data', 'not_derived', 'failed']) {
    assert.equal(isFinalStatus(REPORT_KIND.MONTH, status), false, `${status} must not be final`);
  }
  assert.equal(isFinalStatus(REPORT_KIND.MONTH, 'not_derived'), false);

  // The rollup takes the worst status and ignores anything it does not recognise.
  assert.equal(verdictOf(['calculated', 'calculated']), 'calculated');
  assert.equal(verdictOf(['calculated', 'no_data']), 'no_data');
  assert.equal(verdictOf(['calculated', 'no_data', 'not_derived']), 'not_derived');
  assert.equal(verdictOf(['calculated', 'partial']), 'partial');
  assert.equal(verdictOf(['partial', 'pending_policy']), 'pending_policy');
  assert.equal(verdictOf(['nonsense']), null);
  assert.equal(verdictOf([]), null);
});

test('the academic year is 1 June to 31 May and says so', () => {
  const period = academicYearPeriod(2026);
  assert.equal(period.from, '2026-06-01');
  assert.equal(period.to, '2027-05-31');
  assert.equal(period.months.length, 12);
  assert.deepEqual(period.months[0], { year: 2026, month: 6 });
  assert.deepEqual(period.months[6], { year: 2026, month: 12 }, 'June..December of the start year');
  assert.deepEqual(period.months[7], { year: 2027, month: 1 }, 'then January..May of the next year');
  assert.deepEqual(period.months[11], { year: 2027, month: 5 });
  assert.throws(() => academicYearPeriod('nope'), (error) => error.code === 'REPORT_INVALID_PERIOD');
});

// --- day reports -------------------------------------------------------------

test('a day report names its rule version, cutoff and population, and is final when judged', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);

  const { report, day, rule } = await reportService(repositories).dayReport(
    ADMIN_AUTH, USER_UID, MONDAY,
  );

  assert.equal(report.kind, 'day');
  assert.equal(report.computationStatus, 'calculated');
  assert.equal(report.isFinal, true);
  assert.deepEqual(report.ruleVersions, ['AR-0001'], 'the rule that produced the numbers is named');
  assert.equal(report.dateCutoff, MONDAY, 'the cutoff is the day itself');
  assert.deepEqual(report.population, { employees: 1, employeeUid: USER_UID, dayRows: 1 });
  assert.deepEqual(report.statusReasons, [], 'a final report explains no gap');
  assert.deepEqual(report.period, { from: MONDAY, to: MONDAY, date: MONDAY });

  assert.equal(day.status, 'late');
  assert.equal(day.lateMinutes, 15);
  assert.equal(rule.ruleVersionCode, 'AR-0001');

  // The approver is still a session label, so the caveat travels with the report rather than being lost.
  const codes = report.caveats.map((caveat) => caveat.code);
  assert.ok(codes.includes(REPORT_CAVEAT.APPROVER_IS_SESSION_LABEL));
  assert.ok(report.caveats.every((caveat) => typeof caveat.detail === 'string' && caveat.detail.length > 0));
});

test('a day that was never calculated reports not_derived, never a zero day', async () => {
  const repositories = createFixtureRepositories();
  const { report, day, rule } = await reportService(repositories).dayReport(
    ADMIN_AUTH, USER_UID, '2026-03-09',
  );

  assert.equal(report.computationStatus, 'not_derived');
  assert.equal(report.isFinal, false);
  assert.equal(report.dateCutoff, null, 'no stored day means no cutoff — not the requested date');
  assert.equal(report.population.dayRows, 0);
  assert.deepEqual(report.statusReasons, ['day_never_calculated']);
  assert.equal(day, null);
  assert.equal(rule, null);
});

test('a day whose judgement was withheld is not final and says why', async () => {
  const repositories = createFixtureRepositories();
  await repositories.dailyAttendance.upsertDay(dayRow({ isOvernight: true, date: '2026-03-10' }));

  const { report, day } = await reportService(repositories).dayReport(ADMIN_AUTH, USER_UID, '2026-03-10');

  assert.equal(report.computationStatus, 'insufficient_data');
  assert.equal(report.isFinal, false);
  assert.deepEqual(report.statusReasons, ['day_insufficient_data', 'day_reason:single_scan_only']);
  assert.equal(day.isOvernight, true);
  const codes = report.caveats.map((caveat) => caveat.code);
  assert.ok(codes.includes(REPORT_CAVEAT.NIGHT_SHIFT_LATENESS_WITHHELD), 'overnight lateness is withheld');
});

test('a rejected date fails before anything is read', async () => {
  const repositories = createFixtureRepositories();
  await assert.rejects(
    () => reportService(repositories).dayReport(ADMIN_AUTH, USER_UID, '2026-02-31'),
    (error) => error.status === 400,
  );
});

// --- month reports -----------------------------------------------------------

test('a derived month is final and carries its provenance', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);

  const { report, month, days, dayCounts } = await reportService(repositories).monthReport(
    ADMIN_AUTH, USER_UID, YEAR, MONTH,
  );

  assert.equal(report.kind, 'month');
  assert.equal(report.computationStatus, 'calculated');
  assert.equal(report.isFinal, true);
  assert.deepEqual(report.ruleVersions, ['AR-0001']);
  assert.equal(report.dateCutoff, '2026-03-06', 'the newest stored day included');
  assert.deepEqual(report.period, {
    from: '2026-03-01', to: '2026-03-31', year: YEAR, month: MONTH, key: '2026-03',
  });
  assert.equal(report.population.dayRows, 6);
  assert.equal(month.isFinal, true);
  assert.equal(month.totalLate, 1);
  assert.equal(month.totalLateMinutes, 15);
  assert.equal(month.expectedWorkingDays, 22);
  assert.equal(days.length, 6);
  // Mar 1 is a Sunday (non-working), Mar 2-4 were judged, Mar 5-6 are absences — and an absence is a
  // COMPLETE judgement, not a gap, so the month is still `calculated`.
  assert.equal(dayCounts.byComputationStatus.calculated, 4);
  assert.equal(dayCounts.byComputationStatus.no_data, 2);
  assert.deepEqual(report.statusReasons, []);
});

test('a month containing an unjudged day is NOT final and names the hole', async () => {
  const repositories = createFixtureRepositories();
  const daily = createDailyAttendanceService({ repositories });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 08:45:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${MONDAY} 16:30:00`, checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: MONDAY, to: MONDAY });
  await repositories.dailyAttendance.upsertDay(dayRow({ date: '2026-03-03' }));
  await createMonthlySummaryService({ repositories }).recalculateMonth(ADMIN_AUTH, USER_UID, YEAR, MONTH);

  const { report, month } = await reportService(repositories).monthReport(ADMIN_AUTH, USER_UID, YEAR, MONTH);

  assert.equal(report.computationStatus, 'partial');
  assert.equal(report.isFinal, false, 'a partial month must never be rendered as a final figure');
  assert.equal(month.isFinal, false);
  assert.ok(report.statusReasons.includes('month_partial'));
  assert.ok(report.statusReasons.includes('unjudged_days:1'), 'the size of the hole is stated');
  // The empty holiday calendar is a limitation of the EXPECTED-days figure and must be surfaced with it.
  assert.ok(report.caveats.map((c) => c.code).includes(REPORT_CAVEAT.HOLIDAY_CALENDAR_EMPTY));
});

test('a pending-policy month is not final and claims no expected days', async () => {
  const repositories = createFixtureRepositories();
  const daily = createDailyAttendanceService({ repositories });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2027-03-01 08:45:00', checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: '2027-03-01 16:30:00', checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: '2027-03-01', to: '2027-03-01' });
  await createMonthlySummaryService({ repositories }).recalculateMonth(ADMIN_AUTH, USER_UID, 2027, MONTH);

  const { report, month } = await reportService(repositories).monthReport(ADMIN_AUTH, USER_UID, 2027, MONTH);

  assert.equal(report.computationStatus, 'pending_policy');
  assert.equal(report.isFinal, false);
  assert.ok(report.statusReasons.includes('month_pending_policy'));
  assert.equal(month.expectedWorkingDays, null, 'NULL, never 0: nobody derived an expected figure');
  // expected_working_days is not derived, so the holiday caveat does not apply to a figure that is absent.
  assert.equal(report.caveats.map((c) => c.code).includes(REPORT_CAVEAT.HOLIDAY_CALENDAR_EMPTY), false);
});

test('a month that was never derived is not_derived, and no zeros are invented', async () => {
  const repositories = createFixtureRepositories();
  const { report, month, days } = await reportService(repositories).monthReport(
    ADMIN_AUTH, USER_UID, 2026, 7,
  );

  assert.equal(report.computationStatus, 'not_derived');
  assert.equal(report.isFinal, false);
  assert.equal(month, null, 'there is no month body to mistake for a month of zeros');
  assert.deepEqual(days, []);
  assert.deepEqual(report.statusReasons, ['month_never_derived']);
  assert.equal(report.dateCutoff, null);
});

test('a seeded month without rule provenance reports an empty rule-version list honestly', async () => {
  const repositories = createFixtureRepositories();
  // The fixture seeds 2026-03 with totals but no rule version. The report must not invent one.
  const { report } = await reportService(repositories).monthReport(ADMIN_AUTH, USER_UID, YEAR, MONTH);
  assert.equal(report.computationStatus, 'calculated');
  assert.deepEqual(report.ruleVersions, []);
});

test('an out-of-range month is rejected', async () => {
  const repositories = createFixtureRepositories();
  await assert.rejects(
    () => reportService(repositories).monthReport(ADMIN_AUTH, USER_UID, 1999, 13),
    (error) => error.status === 400 && error.code === 'REPORT_INVALID_PERIOD',
  );
});

// --- academic-year reports ---------------------------------------------------

test('an academic year lists every month, excludes months not yet started, and is never final early', async () => {
  const repositories = createFixtureRepositories();
  const daily = createDailyAttendanceService({ repositories });
  // Derive June 2026 (inside the 2026 academic year) so one month is real and the rest are gaps.
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${JUNE_2026} 08:30:00`, checkType: 'I' });
  await addScan(repositories, { employeeUid: USER_UID, eventTime: `${JUNE_2026} 16:30:00`, checkType: 'O' });
  await daily.recalculateRange({ employeeUid: USER_UID, from: JUNE_2026, to: JUNE_2026 });
  await createMonthlySummaryService({ repositories }).recalculateMonth(ADMIN_AUTH, USER_UID, 2026, 6);

  // 2026-10-16 is mid-year, so Jul-Oct have started and Nov-May have not.
  const service = reportService(repositories, () => new Date('2026-10-16T00:00:00Z'));
  const { report, months, yearSummary } = await service.academicYearReport(ADMIN_AUTH, USER_UID, 2026);

  assert.equal(report.kind, 'academic_year');
  assert.deepEqual(report.period, {
    from: '2026-06-01',
    to: '2027-05-31',
    academicYear: 2026,
    academicYearStartMonth: 6,
  });
  assert.equal(report.isFinal, false);
  assert.equal(report.computationStatus, 'not_derived', 'the worst started month decides');
  assert.ok(report.statusReasons.includes('academic_year_not_closed'));
  assert.ok(report.statusReasons.includes('month_not_derived:2026-07'));

  assert.equal(months.length, 12);
  const june = months.find((entry) => entry.key === '2026-06');
  assert.equal(june.computationStatus, 'calculated');
  assert.equal(june.isFinal, true);
  assert.equal(june.reportAvailable, true);
  assert.deepEqual(june.ruleVersions, ['AR-0001']);
  assert.equal(june.dateCutoff, JUNE_2026);

  assert.equal(yearSummary.asOf, '2026-10-16');
  assert.equal(yearSummary.periodClosed, false);
  assert.equal(yearSummary.monthsStarted, 5, 'June to October');
  assert.deepEqual(yearSummary.monthsNotYetStarted, [
    '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05',
  ]);
  assert.deepEqual(yearSummary.monthsMissing, ['2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(yearSummary.totals.totalPresent, 1, 'only the derived month contributes');
  assert.equal(yearSummary.totals.expectedWorkingDays, 22, 'June 2026 has 22 weekdays');
  assert.equal(report.dateCutoff, JUNE_2026);
});

test('a closed academic year whose months are all calculated is final', async () => {
  const repositories = createFixtureRepositories();
  for (const entry of academicYearPeriod(2025).months) {
    await seedMonth(repositories, { year: entry.year, month: entry.month });
  }

  const service = reportService(repositories, () => new Date('2026-10-16T00:00:00Z'));
  const { report, yearSummary } = await service.academicYearReport(ADMIN_AUTH, USER_UID, 2025);

  assert.equal(report.computationStatus, 'calculated');
  assert.equal(report.isFinal, true, 'closed period, every month derived and judged');
  assert.deepEqual(report.statusReasons, []);
  assert.deepEqual(yearSummary.monthsMissing, []);
  assert.equal(yearSummary.periodClosed, true);
  assert.equal(yearSummary.monthsNotYetStarted.length, 0);
  assert.equal(yearSummary.totals.totalPresent, 12 * 18);
  assert.equal(yearSummary.totals.expectedWorkingDays, 12 * 22);
});

test('one unapproved month makes the whole academic year not final', async () => {
  const repositories = createFixtureRepositories();
  for (const entry of academicYearPeriod(2025).months) {
    await seedMonth(repositories, {
      year: entry.year,
      month: entry.month,
      computationStatus: entry.month === 1 ? 'pending_policy' : 'calculated',
      expectedWorkingDays: entry.month === 1 ? null : 22,
    });
  }

  const service = reportService(repositories, () => new Date('2026-10-16T00:00:00Z'));
  const { report, yearSummary } = await service.academicYearReport(ADMIN_AUTH, USER_UID, 2025);

  assert.equal(report.computationStatus, 'pending_policy');
  assert.equal(report.isFinal, false);
  assert.ok(report.statusReasons.includes('month_pending_policy:2026-01'));
  // A summed NULL would read as "nobody was expected to work", so the total stays NULL too.
  assert.equal(yearSummary.totals.expectedWorkingDays, null);
  assert.equal(yearSummary.totals.totalPresent, 12 * 18);
});

test('an academic year with nothing derived reports not_derived, not twelve empty months', async () => {
  const repositories = createFixtureRepositories();
  const service = reportService(repositories, () => new Date('2026-10-16T00:00:00Z'));
  const { report, yearSummary } = await service.academicYearReport(ADMIN_AUTH, USER_UID, 2030);

  assert.equal(report.computationStatus, 'not_derived');
  assert.equal(report.isFinal, false);
  assert.equal(yearSummary.monthsStarted, 0);
  assert.deepEqual(yearSummary.monthsMissing, []);
  assert.equal(yearSummary.monthsNotYetStarted.length, 12);
  assert.equal(report.dateCutoff, null);
});

// --- authorization -----------------------------------------------------------

test('scope is enforced on every report, before existence is revealed', async () => {
  const repositories = createFixtureRepositories();
  await populateMarch(repositories);
  const employee = { employeeUid: USER_UID, role: 'user' };
  const service = reportService(repositories);

  for (const call of [
    () => service.dayReport(employee, ADMIN_UID, MONDAY),
    () => service.monthReport(employee, ADMIN_UID, YEAR, MONTH),
    () => service.academicYearReport(employee, ADMIN_UID, 2026),
  ]) {
    await assert.rejects(call, (error) => error.status === 403 && error.code === 'FORBIDDEN');
  }

  // With a broad scope, a genuinely unknown employee is a 404 — never a silent empty report.
  repositories.authorization.grantsFor = async (uid) => [
    { employeeUid: uid, scopeType: 'organization', role: 'EXECUTIVE' },
  ];
  const executive = { employeeUid: ADMIN_UID, role: 'executive' };
  await assert.rejects(
    () => service.monthReport(executive, 'ffffffff-ffff-ffff-ffff-ffffffffffff', YEAR, MONTH),
    (error) => error.status === 404 && error.code === 'REPORT_UNKNOWN_EMPLOYEE',
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

test('the report endpoints are authenticated and scope-bound', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  const paths = [
    `/api/v1/attendance/report/day/${USER_UID}/${MONDAY}`,
    `/api/v1/attendance/report/month/${USER_UID}/${YEAR}/${MONTH}`,
    `/api/v1/attendance/report/academic-year/${USER_UID}/2026`,
  ];
  const crossPaths = [
    `/api/v1/attendance/report/day/${ADMIN_UID}/${MONDAY}`,
    `/api/v1/attendance/report/month/${ADMIN_UID}/${YEAR}/${MONTH}`,
    `/api/v1/attendance/report/academic-year/${ADMIN_UID}/2026`,
  ];
  try {
    for (const path of paths) {
      const anonymous = await api(port, 'GET', path);
      assert.equal(anonymous.status, 401, `${path} must require a token`);
    }

    const user = await login(port, 'user@example.test');

    for (const path of paths) {
      const own = await api(port, 'GET', path, { token: user.accessToken });
      assert.equal(own.status, 200, path);
      assert.equal(own.body.success, true);
      assert.equal(typeof own.body.data.report.computationStatus, 'string');
      assert.equal(typeof own.body.data.report.isFinal, 'boolean');
      assert.ok(Array.isArray(own.body.data.report.ruleVersions));
      assert.equal(JSON.stringify(own.body.data).includes('passwordHash'), false);
    }

    for (const path of crossPaths) {
      const cross = await api(port, 'GET', path, { token: user.accessToken });
      assert.equal(cross.status, 403, path);
      assert.equal(cross.body.error.code, 'FORBIDDEN');
    }

    // The seeded fixture month is a stored row, so it is final and its totals are readable.
    const month = await api(port, 'GET', paths[1], { token: user.accessToken });
    assert.equal(month.body.data.report.computationStatus, 'calculated');
    assert.equal(month.body.data.report.isFinal, true);
    assert.equal(month.body.data.month.totalPresent, 20);
    assert.deepEqual(month.body.data.report.population, {
      employees: 1, employeeUid: USER_UID, dayRows: 0,
    });

    // The day was never calculated in fixture mode, so it must not look like a zero day.
    const day = await api(port, 'GET', paths[0], { token: user.accessToken });
    assert.equal(day.body.data.report.computationStatus, 'not_derived');
    assert.equal(day.body.data.report.isFinal, false);
    assert.equal(day.body.data.day, null);
  } finally {
    server.close();
  }
});
