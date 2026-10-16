/**
 * R-04 synthetic source scenarios (test helper only). No database, no network, no real personnel data.
 *
 * This helper builds its OWN fixture repository sets. It deliberately does NOT touch
 * `src/dev/fixtures.js`, because many existing suites depend on that file.
 *
 * The engine (`createDailyAttendanceService` / `createMonthlySummaryService`) is used to produce the
 * canonical daily/monthly rows, so a "clean" scenario is consistent BY CONSTRUCTION rather than by the
 * helper re-deriving attendance logic.
 */
const { createFixtureEmployeeIdentifierRepository } = require('../../src/repositories/fixtureEmployeeIdentifierRepository');
const { createFixtureEmployeeAssignmentRepository } = require('../../src/repositories/fixtureEmployeeAssignmentRepository');
const { createFixtureAttendanceRuleRepository } = require('../../src/repositories/fixtureAttendanceRuleRepository');
const { createFixtureDailyAttendanceRepository } = require('../../src/repositories/fixtureDailyAttendanceRepository');
const { createFixtureMonthlySummaryRepository } = require('../../src/repositories/fixtureMonthlySummaryRepository');
const { EmployeeRepository } = require('../../src/repositories/employeeRepository');
const { LeaveRepository } = require('../../src/repositories/leaveRepository');
const { createDailyAttendanceService } = require('../../src/services/dailyAttendanceService');
const { createMonthlySummaryService } = require('../../src/services/monthlySummaryService');
const { wallDateOnly } = require('../../src/utils/bangkokTime');
const { enumerateMonthDays, isoDayNumber } = require('../../src/domain/monthlyAttendanceCalculation');

const UID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SHARED_THAI_NAME = Object.freeze({ firstNameTh: 'สมชาย', lastNameTh: 'ใจดี' });

const MONTH_2026 = Object.freeze({ year: 2026, month: 3, from: '2026-03-01', to: '2026-03-31' });
const MARCH_MONDAY = '2026-03-02'; // a Monday
const MARCH_TUESDAY = '2026-03-03';
const MARCH_WEDNESDAY = '2026-03-04';
const MARCH_THURSDAY = '2026-03-05';

const RULE_2026 = Object.freeze({
  ruleVersionCode: 'AR-R04-2026',
  name: 'R-04 synthetic 2026 (owner-approved)',
  status: 'approved',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
  workStart: '08:30:00',
  workEnd: '16:30:00',
  lateAfter: '08:30:00',
  earlyBefore: '16:30:00',
  overnightShift: false,
  maxShiftSpanMinutes: 960,
  ignoreHolidays: true,
  workDays: [1, 2, 3, 4, 5],
  approvedBy: 'owner:session-r04-synthetic',
  approvedAt: '2026-01-01T00:00:00.000Z',
});

const RULE_2027_PENDING = Object.freeze({
  ruleVersionCode: 'AR-R04-2027',
  name: 'R-04 synthetic 2027 (NOT approved)',
  status: 'pending_approval',
  effectiveFrom: '2027-01-01',
  effectiveTo: null,
  workStart: '08:30:00',
  workEnd: '16:30:00',
  lateAfter: '08:30:00',
  earlyBefore: '16:30:00',
  overnightShift: false,
  maxShiftSpanMinutes: 960,
  ignoreHolidays: true,
  workDays: [1, 2, 3, 4, 5],
  approvedBy: null,
  approvedAt: null,
});

const RULE_2028 = Object.freeze({ ...RULE_2026, ruleVersionCode: 'AR-R04-2028', effectiveFrom: '2028-01-01', effectiveTo: '2028-12-31' });

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

/** A tiny in-memory attendance_events twin with the methods reconciliation reads plus an `all()` hook. */
function createEventRepository(initial = []) {
  let nextId = 1;
  const rows = [];
  for (const row of initial) rows.push({ id: nextId++, ...row });
  return {
    async insert(event) {
      const record = { id: nextId++, ...event };
      rows.push(record);
      return { ...record };
    },
    async listByEmployee(employeeUid) {
      return rows.filter((row) => row.employeeUid === employeeUid).map((row) => ({ ...row }));
    },
    async listForEmployeeRange({ employeeUid, from, to }) {
      return rows
        .filter((row) => row.employeeUid === employeeUid)
        .filter((row) => {
          const day = wallDateOnly(row.eventTime);
          return Boolean(day) && day >= from && day <= to;
        })
        .sort((a, b) => (String(a.eventTime) < String(b.eventTime) ? -1
          : String(a.eventTime) > String(b.eventTime) ? 1 : (a.id ?? 0) - (b.id ?? 0)))
        .map((row) => ({ ...row }));
    },
    async listEmployeeUidsWithEvents({ from, to }) {
      const uids = new Set();
      for (const row of rows) {
        const day = wallDateOnly(row.eventTime);
        if (row.employeeUid && day && day >= from && day <= to) uids.add(row.employeeUid);
      }
      return Array.from(uids).sort();
    },
    /** Test hook: every stored scan. Used for immutability snapshots and cross-employee scans. */
    all() {
      return rows.map((row) => ({ ...row }));
    },
  };
}

/** Identifier repo = the fixture twin plus an `all()` hook so cross-employee conflicts can be seen. */
function createIdentifierRepository(initial = []) {
  const repo = createFixtureEmployeeIdentifierRepository(initial);
  const snapshot = initial.map((row) => ({
    status: 'active', effectiveFrom: null, effectiveTo: null, ...row,
  }));
  return {
    ...repo,
    async all() {
      return snapshot.map((row) => ({ ...row }));
    },
  };
}

function employeeRow(overrides) {
  return {
    employeeId: 'E-XXX',
    firstNameTh: 'ทดสอบ',
    lastNameTh: 'ระบบ',
    email: null,
    department: 'สำนักงาน',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    status: 'active',
    role: 'user',
    lockedUntil: null,
    ...overrides,
  };
}

function assignmentRow(employeeUid, employeeCode, overrides = {}) {
  return {
    employeeUid,
    employeeCode,
    department: 'สำนักงาน',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    sourceSystem: 'fixture',
    sourceReference: 'synthetic-r04',
    ...overrides,
  };
}

function identifierRow(employeeUid, idType, idValue, overrides = {}) {
  return {
    employeeUid,
    idType,
    idValue,
    sourceSystem: 'fixture',
    isPrimary: true,
    status: 'active',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    ...overrides,
  };
}

function buildRepositorySet({
  employees = [],
  identifiers = [],
  assignments = [],
  ruleVersions = [RULE_2026],
  holidays = [],
  schedules = [],
  events = [],
  dailyRows = [],
  monthlyRows = [],
  leaveRows = [],
} = {}) {
  return {
    employees: new EmployeeRepository(employees.map(employeeRow)),
    leave: new LeaveRepository(leaveRows, []),
    authorization: {
      async grantsFor() { return []; },
      async uidsInOrgUnits() { return []; },
    },
    attendanceEvents: createEventRepository(events),
    employeeIdentifiers: createIdentifierRepository(identifiers),
    employeeAssignments: createFixtureEmployeeAssignmentRepository(assignments),
    attendanceRules: createFixtureAttendanceRuleRepository({ ruleVersions, holidays, schedules }),
    dailyAttendance: createFixtureDailyAttendanceRepository(dailyRows),
    monthlySummaries: createFixtureMonthlySummaryRepository(monthlyRows),
  };
}

/** Derive the canonical daily rows and the stored month with the REAL services (never re-implemented). */
async function deriveCanonical(repositories, { employeeUid, year, month, from, to }) {
  const daily = createDailyAttendanceService({ repositories });
  await daily.recalculateRange({ employeeUid, from, to });
  await createMonthlySummaryService({ repositories }).recalculateMonth(
    { employeeUid, role: 'admin' }, employeeUid, year, month,
  );
}

function addScan(repositories, { employeeUid, eventTime, checkType }) {
  return repositories.attendanceEvents.insert({ employeeUid, eventTime, checkType });
}

/** Working-day scan pairs (on time) for a whole month, so a month is derived for every working day. */
function onTimeScanPairs(employeeUid, year, month) {
  const events = [];
  for (const date of enumerateMonthDays(year, month)) {
    const dayNumber = isoDayNumber(date);
    if (dayNumber == null || dayNumber > 5) continue; // Mon-Fri only
    events.push({ employeeUid, eventTime: `${date} 08:30:00`, checkType: 'I' });
    events.push({ employeeUid, eventTime: `${date} 16:30:00`, checkType: 'O' });
  }
  return events;
}

function authFor(employeeUid) {
  return { employeeUid, role: 'admin' };
}

/** Deep JSON snapshot of every store that exposes an `all()` hook, for the immutability test. */
function snapshotStores(repositories) {
  const stores = {};
  for (const name of [
    'attendanceEvents', 'employeeIdentifiers', 'employeeAssignments', 'attendanceRules',
    'dailyAttendance', 'monthlySummaries', 'employees', 'leave',
  ]) {
    const repo = repositories[name];
    if (repo && typeof repo.all === 'function') stores[name] = repo.all();
  }
  return JSON.stringify(stores);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/** 1. clean — a working month where every check agrees. Expected: matched. */
async function cleanMonth() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-CLEAN-A')];
  const assignments = [assignmentRow(UID_A, 'E-CLEAN-A')];
  const events = onTimeScanPairs(UID_A, MONTH_2026.year, MONTH_2026.month);
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, {
    employeeUid: UID_A, year: MONTH_2026.year, month: MONTH_2026.month, from: MONTH_2026.from, to: MONTH_2026.to,
  });
  return { repositories, employeeUid: UID_A, auth: authFor(UID_A) };
}

/** 2. duplicate scans — an identical timestamp+checkType duplicate. Expected: incomplete (reported). */
async function duplicateScans() {
  const scenario = await cleanMonth();
  await addScan(scenario.repositories, { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:30:00`, checkType: 'I' });
  return scenario;
}

/** 3. conflicting employee codes — two employees share a code over the same window. Expected: blocked. */
async function conflictingEmployeeCodes() {
  const employees = [
    employeeRow({ employeeUid: UID_A, employeeId: 'E-A' }),
    employeeRow({ employeeUid: UID_B, employeeId: 'E-B' }),
  ];
  const identifiers = [
    identifierRow(UID_A, 'personnel_id', 'P-CONFLICT-A'),
    identifierRow(UID_B, 'personnel_id', 'P-CONFLICT-B'),
  ];
  const assignments = [
    assignmentRow(UID_A, 'E-SHARED'),
    assignmentRow(UID_B, 'E-SHARED'),
  ];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_B, eventTime: `${MARCH_MONDAY} 08:35:00`, checkType: 'I' },
    { employeeUid: UID_B, eventTime: `${MARCH_MONDAY} 16:35:00`, checkType: 'O' },
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: MARCH_MONDAY, to: MARCH_MONDAY });
  return {
    repositories, employeeUid: UID_A, otherUid: UID_B, auth: authFor(UID_A), otherAuth: authFor(UID_B),
  };
}

/** 4. same-name employees — identical Thai names, different uids. Proves no name-based join. */
async function sameNameEmployees() {
  const employees = [
    employeeRow({ employeeUid: UID_A, employeeId: 'E-SAME-A', ...SHARED_THAI_NAME }),
    employeeRow({ employeeUid: UID_B, employeeId: 'E-SAME-B', ...SHARED_THAI_NAME }),
  ];
  const identifiers = [
    identifierRow(UID_A, 'personnel_id', 'P-SAME-A'),
    identifierRow(UID_B, 'personnel_id', 'P-SAME-B'),
  ];
  const assignments = [assignmentRow(UID_A, 'E-SAME-A'), assignmentRow(UID_B, 'E-SAME-B')];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:45:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_B, eventTime: `${MARCH_WEDNESDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_B, eventTime: `${MARCH_WEDNESDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_B, eventTime: `${MARCH_THURSDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_B, eventTime: `${MARCH_THURSDAY} 16:30:00`, checkType: 'O' },
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: MONTH_2026.from, to: MONTH_2026.to });
  await deriveCanonical(repositories, { employeeUid: UID_B, year: 2026, month: 3, from: MONTH_2026.from, to: MONTH_2026.to });
  return {
    repositories, employeeUid: UID_A, otherUid: UID_B, auth: authFor(UID_A), otherAuth: authFor(UID_B),
    sharedName: SHARED_THAI_NAME,
  };
}

/** 5. missing scans — an expected working day (Thu) has no scans and no row. Expected: incomplete. */
async function missingScans() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-MISS-A')];
  const assignments = [assignmentRow(UID_A, 'E-MISS-A')];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_A, eventTime: `${MARCH_WEDNESDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_WEDNESDAY} 16:30:00`, checkType: 'O' },
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  // Derived only over Mon-Wed, so Thursday (a working day) has no canonical row at all.
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: '2026-03-01', to: MARCH_WEDNESDAY });
  return { repositories, employeeUid: UID_A, missingDay: MARCH_THURSDAY, auth: authFor(UID_A) };
}

/** 6. partial month — a derived month that contains an unjudged day. Expected: incomplete. */
async function partialMonth() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-PART-A')];
  const assignments = [assignmentRow(UID_A, 'E-PART-A')];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 08:30:00`, checkType: 'I' }, // single scan -> insufficient_data
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: '2026-03-01', to: MARCH_TUESDAY });
  return { repositories, employeeUid: UID_A, auth: authFor(UID_A) };
}

/** 7. pending policy — a 2027 date whose only covering rule is not approved. Expected: incomplete. */
function pendingPolicy2027() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-2027-A', { effectiveFrom: '2026-01-01', effectiveTo: null })];
  const assignments = [assignmentRow(UID_A, 'E-2027-A', { effectiveFrom: '2026-01-01', effectiveTo: null })];
  const repositories = buildRepositorySet({
    employees, identifiers, assignments, ruleVersions: [RULE_2026, RULE_2027_PENDING],
  });
  return { repositories, employeeUid: UID_A, date: '2027-03-01', auth: authFor(UID_A) };
}

/** 8. never derived — a month with no canonical rows and no scans. Expected: incomplete, never matched. */
function neverDerived() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-NEVER-A')];
  const assignments = [assignmentRow(UID_A, 'E-NEVER-A')];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events: [] });
  return { repositories, employeeUid: UID_A, year: 2026, month: 7, auth: authFor(UID_A) };
}

/** 9a. boundaries — scans either side of midnight must land on their own Bangkoks wall day. */
async function boundaryTimezones() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-TZ-A')];
  const assignments = [assignmentRow(UID_A, 'E-TZ-A')];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 23:00:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 23:30:00`, checkType: 'O' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 00:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_TUESDAY} 01:00:00`, checkType: 'O' },
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: '2026-03-01', to: MARCH_TUESDAY });
  return { repositories, employeeUid: UID_A, auth: authFor(UID_A) };
}

/** 9b. leap February 2028 — a 29-day month, with no rows, so only the period is exercised. */
function leapFebruary2028() {
  const employees = [employeeRow({ employeeUid: UID_A, employeeId: 'E-A' })];
  const identifiers = [identifierRow(UID_A, 'personnel_id', 'P-LEAP-A', { effectiveFrom: '2028-01-01', effectiveTo: '2028-12-31' })];
  const assignments = [assignmentRow(UID_A, 'E-LEAP-A', { effectiveFrom: '2028-01-01', effectiveTo: '2028-12-31' })];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, ruleVersions: [RULE_2028] });
  return { repositories, employeeUid: UID_A, auth: authFor(UID_A) };
}

/** 10. unattributed + foreign scans on the same day. Expected: incomplete, never reassigned. */
async function unattributedAndForeign() {
  const employees = [
    employeeRow({ employeeUid: UID_A, employeeId: 'E-A' }),
    employeeRow({ employeeUid: UID_B, employeeId: 'E-B' }),
  ];
  const identifiers = [
    identifierRow(UID_A, 'personnel_id', 'P-MIX-A'),
    identifierRow(UID_B, 'personnel_id', 'P-MIX-B'),
  ];
  const assignments = [assignmentRow(UID_A, 'E-MIX-A'), assignmentRow(UID_B, 'E-MIX-B')];
  const events = [
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 08:30:00`, checkType: 'I' },
    { employeeUid: UID_A, eventTime: `${MARCH_MONDAY} 16:30:00`, checkType: 'O' },
    { employeeUid: null, eventTime: `${MARCH_MONDAY} 12:00:00`, checkType: 'I' }, // unattributed
    { employeeUid: UID_B, eventTime: `${MARCH_MONDAY} 08:40:00`, checkType: 'I' }, // foreign
  ];
  const repositories = buildRepositorySet({ employees, identifiers, assignments, events });
  await deriveCanonical(repositories, { employeeUid: UID_A, year: 2026, month: 3, from: MARCH_MONDAY, to: MARCH_MONDAY });
  return { repositories, employeeUid: UID_A, otherUid: UID_B, auth: authFor(UID_A) };
}

module.exports = {
  UID_A,
  UID_B,
  SHARED_THAI_NAME,
  MONTH_2026,
  MARCH_MONDAY,
  MARCH_TUESDAY,
  MARCH_WEDNESDAY,
  MARCH_THURSDAY,
  RULE_2026,
  RULE_2027_PENDING,
  RULE_2028,
  buildRepositorySet,
  createEventRepository,
  createIdentifierRepository,
  employeeRow,
  assignmentRow,
  identifierRow,
  deriveCanonical,
  addScan,
  onTimeScanPairs,
  authFor,
  snapshotStores,
  cleanMonth,
  duplicateScans,
  conflictingEmployeeCodes,
  sameNameEmployees,
  missingScans,
  partialMonth,
  pendingPolicy2027,
  neverDerived,
  boundaryTimezones,
  leapFebruary2028,
  unattributedAndForeign,
};
