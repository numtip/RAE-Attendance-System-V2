/**
 * R-04 reconciliation snapshots (synthetic fixture repositories, no database).
 *
 * The suite pins the honesty contract, not arithmetic: the derived status for every scenario, the fact
 * that reconciliation NEVER writes (the most important test here), deterministic hashes, the NULL
 * discipline, the fiscal-vs-academic separation and the authorization surface.
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('./helpers/syntheticIdentifierKeys');

const { createReconciliationService } = require('../src/services/reconciliationService');
const { createApp } = require('../src/app');
const { formatBangkokWall, wallDateOnly } = require('../src/utils/bangkokTime');
const { verdictOf, makeCheck } = require('../src/domain/reconciliation');
const sources = require('./helpers/reconciliationSources');

const FIXED_NOW = () => new Date('2026-10-16T00:00:00.000Z');

function makeService(repositories, now = FIXED_NOW) {
  return createReconciliationService({ repositories, now });
}

function codes(snapshot) {
  return snapshot.unresolvedExceptions.map((entry) => entry.code);
}

function checkOf(snapshot, code) {
  return snapshot.checks.find((entry) => entry.code === code);
}

// --- domain: the verdict rules ----------------------------------------------

test('verdictOf: an empty or unknown check list is incomplete, never matched', () => {
  assert.equal(verdictOf([]), 'incomplete');
  assert.equal(verdictOf([makeCheck('x', 'matched')]), 'matched');
  assert.equal(verdictOf([makeCheck('x', 'matched'), makeCheck('y', 'incomplete')]), 'incomplete');
  assert.equal(verdictOf([makeCheck('x', 'incomplete'), makeCheck('y', 'mismatched')]), 'mismatched');
  assert.equal(
    verdictOf([makeCheck('x', 'mismatched'), makeCheck('y', 'blocked'), makeCheck('z', 'incomplete')]),
    'blocked',
    'blocked outranks everything',
  );
  assert.equal(verdictOf([{ status: 'nonsense' }]), 'incomplete', 'unknown statuses are ignored');
  assert.throws(() => makeCheck('x', 'nope'), /unknown reconciliation check status/);
});

// --- scenario 1: clean ------------------------------------------------------

test('clean: a working month where every check agrees is matched', async () => {
  const scenario = await sources.cleanMonth();
  const service = makeService(scenario.repositories);

  const day = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY,
  });
  assert.equal(day.snapshot.kind, 'day');
  assert.equal(day.snapshot.status, 'matched', `day checks: ${JSON.stringify(codes(day.snapshot))}`);
  assert.deepEqual(day.snapshot.unresolvedExceptions, []);
  assert.equal(day.snapshot.counts.matched, day.snapshot.checks.length);
  assert.equal(day.snapshot.detail.events.uniqueCount, 2);

  const month = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: sources.MONTH_2026.year, month: sources.MONTH_2026.month,
  });
  assert.equal(month.snapshot.kind, 'month');
  assert.equal(month.snapshot.status, 'matched', `month checks: ${JSON.stringify(codes(month.snapshot))}`);
  assert.equal(month.snapshot.period.from, '2026-03-01');
  assert.equal(month.snapshot.period.to, '2026-03-31');
  assert.equal(month.snapshot.period.key, '2026-03');
  assert.equal(month.snapshot.completeness.expectedWorkingDays, 22);
  assert.equal(month.snapshot.completeness.missingDays, 0);
});

// --- scenario 2: duplicate scans --------------------------------------------

test('duplicate scans: identical timestamp+type duplicates are incomplete, not fatal', async () => {
  const scenario = await sources.duplicateScans();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY,
  });
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('duplicate_scans'));
  assert.equal(checkOf(snapshot, 'duplicate_scans').observed, 1);
  // The duplicate does not change the canonical count, so scan_count still agrees.
  assert.equal(checkOf(snapshot, 'scan_count').status, 'matched');
});

// --- scenario 3: conflicting employee codes ---------------------------------

test('conflicting employee codes: identity is BLOCKED, never merged or reassigned', async () => {
  const scenario = await sources.conflictingEmployeeCodes();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY,
  });
  assert.equal(snapshot.status, 'blocked');
  assert.ok(codes(snapshot).includes('employee_identity'));
  assert.equal(checkOf(snapshot, 'employee_identity').detail, 'identity_conflict');
  // The target employee still sees ONLY its own scans.
  assert.equal(snapshot.detail.events.attributedCount, 2);

  // The other employee is blocked too: the code is shared, so ownership is ambiguous for both.
  const other = await service.reconcileDay(scenario.otherAuth, {
    employeeUid: scenario.otherUid, date: sources.MARCH_MONDAY,
  });
  assert.equal(other.snapshot.status, 'blocked');
  assert.equal(other.snapshot.detail.events.attributedCount, 2);
});

// --- scenario 4: same-name employees ----------------------------------------

test('same-name employees stay distinct: no name-based join', async () => {
  const scenario = await sources.sameNameEmployees();
  const service = makeService(scenario.repositories);

  const a = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: 2026, month: 3,
  });
  const b = await service.reconcileMonth(scenario.otherAuth, {
    employeeUid: scenario.otherUid, year: 2026, month: 3,
  });

  assert.equal(a.snapshot.population.employeeUid, scenario.employeeUid);
  assert.equal(b.snapshot.population.employeeUid, scenario.otherUid);
  assert.notEqual(a.snapshot.snapshotHash, b.snapshot.snapshotHash, 'the two people are not merged');
  assert.equal(a.snapshot.status, 'matched', `A checks: ${JSON.stringify(codes(a.snapshot))}`);
  assert.equal(b.snapshot.status, 'matched', `B checks: ${JSON.stringify(codes(b.snapshot))}`);

  // A is late once, B never: the populations did not bleed into each other.
  assert.equal(a.snapshot.detail.month.totalLate, 1);
  assert.equal(b.snapshot.detail.month.totalLate, 0);

  // The shared Thai name is identity data and must never appear in a reconciliation payload.
  const serialized = JSON.stringify(a.snapshot);
  assert.equal(serialized.includes(sources.SHARED_THAI_NAME.firstNameTh), false);
  assert.equal(serialized.includes(scenario.otherUid), false, 'the other employee is not disclosed');
});

// --- scenario 5: missing scans ----------------------------------------------

test('missing scans: an expected working day with no row is incomplete', async () => {
  const scenario = await sources.missingScans();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: 2026, month: 3,
  });
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('daily_row_coverage'));
  assert.ok(snapshot.completeness.missingDays > 0);
  assert.ok(snapshot.detail.missingWorkingDays.includes(scenario.missingDay));
});

// --- scenario 6: partial month ----------------------------------------------

test('partial month: a derived month with an unjudged day is incomplete', async () => {
  const scenario = await sources.partialMonth();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: 2026, month: 3,
  });
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('unjudged_days'));
  assert.equal(snapshot.completeness.unjudgedDays, 1);
  assert.equal(checkOf(snapshot, 'unjudged_days').observed, 1);
});

// --- scenario 7: pending policy ---------------------------------------------

test('pending policy: a 2027 date whose only rule is unapproved is incomplete', async () => {
  const scenario = sources.pendingPolicy2027();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: scenario.date,
  });
  assert.equal(snapshot.status, 'incomplete', `checks: ${JSON.stringify(codes(snapshot))}`);
  assert.ok(codes(snapshot).includes('approved_rule'));
  assert.equal(checkOf(snapshot, 'approved_rule').detail, 'rule_pending_approval');
  // Identity is resolvable on the date, so the snapshot is not blocked.
  assert.equal(checkOf(snapshot, 'employee_identity').status, 'matched');
});

// --- scenario 8: never derived ----------------------------------------------

test('never derived: a month with no rows is incomplete, never matched', async () => {
  const scenario = sources.neverDerived();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: scenario.year, month: scenario.month,
  });
  assert.notEqual(snapshot.status, 'matched');
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('daily_row_coverage'));
  assert.ok(codes(snapshot).includes('month_totals'));
  assert.equal(snapshot.detail.month, null);
});

// --- scenario 9: boundaries -------------------------------------------------

test('boundaries: scans either side of midnight land on their own Bangkok day', async () => {
  const scenario = await sources.boundaryTimezones();
  const service = makeService(scenario.repositories);

  const monday = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY,
  });
  const tuesday = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_TUESDAY,
  });

  assert.equal(monday.snapshot.detail.events.attributedCount, 2, 'the 23:00/23:30 scans are Monday');
  assert.equal(tuesday.snapshot.detail.events.attributedCount, 2, 'the 00:30/01:00 scans are Tuesday');
  assert.equal(checkOf(monday.snapshot, 'event_span').status, 'matched');
  assert.equal(checkOf(tuesday.snapshot, 'event_span').status, 'matched');
});

test('boundaries: leap February 2028 is a 29-day month with 21 working days', async () => {
  const scenario = sources.leapFebruary2028();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: 2028, month: 2,
  });
  assert.equal(snapshot.period.from, '2028-02-01');
  assert.equal(snapshot.period.to, '2028-02-29');
  assert.equal(snapshot.completeness.expectedWorkingDays, 21);
});

test('timezone helper: 04:16Z is 11:16 Bangkok wall time, on the same calendar day', () => {
  const wall = formatBangkokWall(new Date('2026-03-02T04:16:00.000Z'));
  assert.equal(wall, '2026-03-02 11:16:00');
  assert.equal(wallDateOnly(wall), '2026-03-02');
  assert.equal(wallDateOnly(new Date('2026-03-02T04:16:00.000Z')), '2026-03-02');
});

// --- scenario 10: unattributed + foreign events -----------------------------

test('unattributed + foreign scans are reported and never reassigned', async () => {
  const scenario = await sources.unattributedAndForeign();
  const service = makeService(scenario.repositories);

  const { snapshot } = await service.reconcileDay(scenario.auth, {
    employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY,
  });
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('unattributed_events'));
  assert.ok(codes(snapshot).includes('foreign_events'));
  assert.equal(snapshot.detail.events.unattributedCount, 1);
  assert.equal(snapshot.detail.events.foreignCount, 1);
  assert.equal(snapshot.detail.events.attributedCount, 2, 'the target keeps only its own scans');
});

// --- NULL discipline --------------------------------------------------------

test('NULL discipline: an underivable expectedWorkingDays stays null, never zero', async () => {
  const repositories = sources.buildRepositorySet({
    employees: [sources.employeeRow({ employeeUid: sources.UID_A, employeeId: 'E-A' })],
    ruleVersions: [], // no approved rule -> expected working days cannot be derived
    monthlyRows: [{
      employeeUid: sources.UID_A,
      year: 2026,
      month: 7,
      totalWorkDays: 0,
      totalPresent: 0,
      totalLate: 0,
      totalAbsent: 0,
      totalLeave: 0,
      totalLateMinutes: 0,
      totalWorkHours: 0,
      expectedWorkingDays: null,
      computationStatus: 'no_data',
      ruleVersions: [],
      dayCounts: {},
    }],
  });
  const service = makeService(repositories);
  const { snapshot } = await service.reconcileMonth(sources.authFor(sources.UID_A), {
    employeeUid: sources.UID_A, year: 2026, month: 7,
  });
  assert.equal(snapshot.completeness.expectedWorkingDays, null);
  const check = checkOf(snapshot, 'expected_working_days');
  assert.equal(check.status, 'matched');
  assert.equal(check.detail, 'expected_working_days_null_agreed');
});

// --- realSourceVerified -----------------------------------------------------

test('realSourceVerified is false and the note explains why', async () => {
  const scenario = await sources.cleanMonth();
  const service = makeService(scenario.repositories);
  const { snapshot } = await service.reconcileMonth(scenario.auth, {
    employeeUid: scenario.employeeUid, year: 2026, month: 3,
  });
  assert.equal(snapshot.realSourceVerified, false);
  assert.equal(typeof snapshot.realSourceNote, 'string');
  assert.ok(snapshot.realSourceNote.length > 0);
  assert.match(snapshot.realSourceNote, /does NOT verify|attendance-report-generator/);
  assert.equal(snapshot.pristine, true);
});

// --- determinism, immutability, no writes -----------------------------------

test('determinism: the snapshotHash is stable even when the clock differs', async () => {
  const scenario = await sources.cleanMonth();
  const first = await makeService(scenario.repositories, () => new Date('2026-10-16T00:00:00Z'))
    .reconcileMonth(scenario.auth, { employeeUid: scenario.employeeUid, year: 2026, month: 3 });
  const second = await makeService(scenario.repositories, () => new Date('2027-05-01T13:45:00Z'))
    .reconcileMonth(scenario.auth, { employeeUid: scenario.employeeUid, year: 2026, month: 3 });

  assert.equal(first.snapshot.snapshotHash, second.snapshot.snapshotHash, 'hash excludes asOf-derived stamps');
  assert.notEqual(first.snapshot.asOf, second.snapshot.asOf);
  assert.notEqual(first.snapshot.cutoff, second.snapshot.cutoff);
  assert.equal(first.snapshot.snapshotHash.length, 64);
});

test('read-only: every store is byte-identical before and after, and no write method runs', async () => {
  const scenario = await sources.cleanMonth();
  const repositories = scenario.repositories;

  // Poison every write method so an accidental write is a test failure, not a silent mutation.
  const writeMethods = [
    [repositories.dailyAttendance, 'upsertDay'],
    [repositories.dailyAttendance, 'deleteForEmployeeDate'],
    [repositories.monthlySummaries, 'upsertMonth'],
    [repositories.attendanceEvents, 'insert'],
    [repositories.employeeIdentifiers, 'insert'],
    [repositories.employeeIdentifiers, 'deactivate'],
    [repositories.employeeAssignments, 'insert'],
    [repositories.employeeAssignments, 'closeAssignment'],
    [repositories.attendanceRules, 'insertRuleVersion'],
    [repositories.attendanceRules, 'insertHoliday'],
    [repositories.attendanceRules, 'insertSchedule'],
  ];
  for (const [repo, method] of writeMethods) {
    repo[method] = () => { throw new Error(`write attempted: ${method}`); };
  }

  const before = sources.snapshotStores(repositories);
  const service = makeService(repositories);
  await service.reconcileDay(scenario.auth, { employeeUid: scenario.employeeUid, date: sources.MARCH_MONDAY });
  await service.reconcileMonth(scenario.auth, { employeeUid: scenario.employeeUid, year: 2026, month: 3 });
  await service.reconcileFiscalYear(scenario.auth, { employeeUid: scenario.employeeUid, fiscalYear: 2569 });
  const after = sources.snapshotStores(repositories);

  assert.equal(after, before, 'reconciliation must not mutate any store');
});

// --- fiscal year ------------------------------------------------------------

test('fiscal year: the snapshot names both the BE year and the Gregorian window', async () => {
  const scenario = await sources.cleanMonth();
  const service = makeService(scenario.repositories);
  const { snapshot } = await service.reconcileFiscalYear(scenario.auth, {
    employeeUid: scenario.employeeUid, fiscalYear: 2569,
  });
  assert.equal(snapshot.kind, 'fiscal_year');
  assert.equal(snapshot.period.fiscalYear, 2569);
  assert.equal(snapshot.period.gregorianFrom, '2025-10-01');
  assert.equal(snapshot.period.gregorianTo, '2026-09-30');
  assert.equal(snapshot.period.from, '2025-10-01');
  assert.equal(snapshot.period.to, '2026-09-30');
  assert.equal(snapshot.period.labelTh, 'ปีงบประมาณ 2569');
  assert.equal(snapshot.detail.months.length, 12);
  // Only March was derived, so the fiscal year cannot be matched.
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(codes(snapshot).includes('fiscal_month_coverage'));
  assert.equal(snapshot.realSourceVerified, false);
  assert.equal(snapshot.pristine, true);
});

// --- authorization (service level) ------------------------------------------

test('authorization: 403 cross-scope and 404 unknown-in-scope, for all three kinds', async () => {
  const scenario = await sources.cleanMonth();
  const service = makeService(scenario.repositories);
  const outsider = { employeeUid: sources.UID_B, role: 'user' };

  const crossCalls = [
    () => service.reconcileDay(outsider, { employeeUid: sources.UID_A, date: sources.MARCH_MONDAY }),
    () => service.reconcileMonth(outsider, { employeeUid: sources.UID_A, year: 2026, month: 3 }),
    () => service.reconcileFiscalYear(outsider, { employeeUid: sources.UID_A, fiscalYear: 2569 }),
  ];
  for (const call of crossCalls) {
    await assert.rejects(call, (error) => error.status === 403 && error.code === 'FORBIDDEN');
  }

  // A broad scope reaches the existence check: an unknown employee is then a 404, never an empty snapshot.
  scenario.repositories.authorization.grantsFor = async (uid) => [
    { employeeUid: uid, scopeType: 'organization', role: 'EXECUTIVE' },
  ];
  const executive = { employeeUid: sources.UID_A, role: 'executive' };
  const unknown = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const unknownCalls = [
    () => service.reconcileDay(executive, { employeeUid: unknown, date: sources.MARCH_MONDAY }),
    () => service.reconcileMonth(executive, { employeeUid: unknown, year: 2026, month: 3 }),
    () => service.reconcileFiscalYear(executive, { employeeUid: unknown, fiscalYear: 2569 }),
  ];
  for (const call of unknownCalls) {
    await assert.rejects(call, (error) => error.status === 404 && error.code === 'RECONCILIATION_UNKNOWN_EMPLOYEE');
  }
});

test('period validation rejects a bad date, month and fiscal year before any read', async () => {
  const scenario = await sources.cleanMonth();
  const service = makeService(scenario.repositories);
  await assert.rejects(
    () => service.reconcileDay(scenario.auth, { employeeUid: sources.UID_A, date: '2026-02-31' }),
    (error) => error.status === 400 && error.code === 'RECONCILIATION_INVALID_PERIOD',
  );
  await assert.rejects(
    () => service.reconcileMonth(scenario.auth, { employeeUid: sources.UID_A, year: 1999, month: 13 }),
    (error) => error.status === 400 && error.code === 'RECONCILIATION_INVALID_PERIOD',
  );
  await assert.rejects(
    () => service.reconcileFiscalYear(scenario.auth, { employeeUid: sources.UID_A, fiscalYear: 'nope' }),
    (error) => error.status === 400 && error.code === 'RECONCILIATION_INVALID_PERIOD',
  );
});

// --- API --------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function api(port, method, path, { token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

async function login(port, email) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'valid-pass' }),
  });
  return { status: response.status, body: await response.json() };
}

test('the reconciliation routes are authenticated, return the envelope and leak no PII', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  const user = '22222222-2222-2222-2222-222222222222';
  const other = '11111111-1111-1111-1111-111111111111';
  const ownPaths = [
    `/api/v1/attendance/reconciliation/day/${user}/2026-03-02`,
    `/api/v1/attendance/reconciliation/month/${user}/2026/3`,
    `/api/v1/attendance/reconciliation/fiscal-year/${user}/2569`,
  ];
  const crossPaths = [
    `/api/v1/attendance/reconciliation/day/${other}/2026-03-02`,
    `/api/v1/attendance/reconciliation/month/${other}/2026/3`,
    `/api/v1/attendance/reconciliation/fiscal-year/${other}/2569`,
  ];
  try {
    for (const path of ownPaths) {
      const anonymous = await api(port, 'GET', path);
      assert.equal(anonymous.status, 401, `${path} must require a token`);
    }

    const loginResponse = await login(port, 'user@example.test');
    assert.equal(loginResponse.status, 200);
    const token = loginResponse.body.data.accessToken;

    for (const path of ownPaths) {
      const own = await api(port, 'GET', path, { token });
      assert.equal(own.status, 200, path);
      assert.equal(own.body.success, true);
      const snapshot = own.body.data.snapshot;
      assert.equal(typeof snapshot.status, 'string');
      assert.equal(snapshot.pristine, true);
      assert.equal(snapshot.realSourceVerified, false);
      assert.ok(Array.isArray(snapshot.checks));
      assert.ok(Array.isArray(snapshot.unresolvedExceptions));
      assert.ok(Array.isArray(snapshot.statusReasons));
      assert.equal(snapshot.snapshotHash.length, 64);
      const serialized = JSON.stringify(own.body.data);
      assert.equal(serialized.includes('passwordHash'), false);
      assert.equal(serialized.includes('nationalId'), false);
      assert.equal(serialized.includes('national_id'), false);
      assert.equal(/\b\d{13}\b/.test(serialized), false, 'no 13-digit national id');
      assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(serialized), false, 'no bearer token');
    }

    for (const path of crossPaths) {
      const cross = await api(port, 'GET', path, { token });
      assert.equal(cross.status, 403, path);
      assert.equal(cross.body.error.code, 'FORBIDDEN');
    }
  } finally {
    server.close();
  }
});
