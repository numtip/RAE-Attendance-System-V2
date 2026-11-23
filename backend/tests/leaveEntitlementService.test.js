const test = require('node:test');
const assert = require('node:assert/strict');

const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { LeaveRepository } = require('../src/repositories/leaveRepository');
const { LeaveRecordRepository } = require('../src/repositories/leaveRecordRepository');
const { LeaveHrRepository } = require('../src/repositories/leaveHrRepository');
const { createLeaveEntitlementService } = require('../src/services/leaveEntitlementService');
const { createLeaveService } = require('../src/services/leaveService');
const { createLeaveController } = require('../src/controllers/leaveController');
const { leaveEngineFlag } = require('../src/config');

const U = 'aaaaaaaa-0000-0000-0000-00000000000a'; // university, established
const D = 'bbbbbbbb-0000-0000-0000-00000000000b'; // department (type not confirmed by the announcement)
const C = 'cccccccc-0000-0000-0000-00000000000c'; // contract (outsourced)
const OP = 'dddddddd-0000-0000-0000-00000000000d'; // HR operator who verified rows
const NOW = () => new Date('2026-11-23T05:00:00Z'); // Bangkok 2026-11-23, inside FY2570
const FY = 2570;
const COVERED_NOW = ['2026-10', '2026-11'];

function employee(uid, type, extra = {}) {
  return { employeeUid: uid, employeeId: uid.slice(0, 4), employeeType: type, status: 'active', hireDate: '2015-04-01', firstNameTh: 'x', lastNameTh: 'y', ...extra };
}

function build({ employees = [employee(U, 'university'), employee(D, 'department'), employee(C, 'contract')], records = [], legacy = [], balances = [], coverage = COVERED_NOW } = {}) {
  const employeeRepo = new EmployeeRepository(employees);
  const leaveRecords = new LeaveRecordRepository();
  leaveRecords.records = records;
  leaveRecords.coverage = coverage.map((sourcePeriod) => ({ sourceSystem: 'hip', sourcePeriod }));
  const repositories = {
    authorization: { async grantsFor() { return []; }, async uidsInOrgUnits() { return []; } },
    employees: employeeRepo,
    leave: new LeaveRepository(legacy, balances),
    leaveRecords,
    leaveHr: new LeaveHrRepository({ employees: employeeRepo }),
  };
  return { repositories, service: createLeaveEntitlementService({ repositories, now: NOW }) };
}

const rec = (uid, date, leaveType, extra = {}) => ({
  recordUid: `R-${uid}-${date}-${leaveType}-${extra.dayPart || 'FULL'}`, employeeUid: uid, leaveDate: date, leaveType, dayPart: 'FULL', dayFraction: 1,
  reviewStatus: 'candidate', reviewReason: null, approvalStatus: 'approved', sourceSystem: 'hip_daily_report_remark', ...extra,
});
const hrRow = (uid, type, extra = {}) => ({
  employeeUid: uid, fiscalYearBe: FY, leaveType: type, entitlementDays: 10, carryoverDays: null, usageBaselineDays: null, usageBaselineThrough: null,
  sourceReference: 'doc', importBatchUid: 'b1', verifiedByUid: OP, ...extra,
});
const profile = (uid, extra = {}) => ({
  employeeUid: uid, continuousServiceStart: '2015-04-01', appointmentKind: 'other', eligibilityConfirmed: null, eligibilityReference: null,
  sourceReference: 'doc', verifiedByUid: OP, ...extra,
});
const byType = (rows) => Object.fromEntries(rows.map((r) => [r.leaveType, r]));

// ------------------------------------------------------------ shape and precedence

test('a fiscal-year row keeps the old balance fields and adds status, source and flags', async () => {
  const { service } = build();
  const rows = await service.balance(U, FY);
  assert.deepEqual(rows.map((r) => r.leaveType), ['sick', 'personal', 'vacation']);
  const sick = byType(rows).sick;
  assert.equal(sick.basis, 'fiscal');
  assert.equal(sick.year, FY);
  assert.deepEqual(sick.fiscalYear, { be: 2570, start: '2026-10-01', end: '2027-09-30' });
  assert.equal(sick.policyVersion, 'MJU-LEAVE-2569');
  assert.deepEqual([sick.status, sick.source, sick.kind], ['ok', 'computed', 'paid_leave_allowance']);
  assert.deepEqual([sick.totalDays, sick.usedDays, sick.remainingDays, sick.available, sick.unavailableReason], [60, 0, 60, true, null]);
  assert.equal(sick.typeLabel, 'ลาป่วย');
  assert.equal(sick.usageComplete, true);
});

test('with no HR row the engine decides; what it cannot decide has no number', async () => {
  const { service } = build();
  const r = byType(await service.balance(U, FY));
  assert.equal(r.personal.status, 'ok');
  assert.equal(r.personal.totalDays, 45);
  // vacation: carry-over is not known, so no balance exists
  assert.deepEqual([r.vacation.status, r.vacation.source, r.vacation.totalDays, r.vacation.remainingDays, r.vacation.available], ['unknown', null, null, null, false]);
  assert.deepEqual(r.vacation.missing, ['vacationCarryoverDays']);
  assert.equal(r.vacation.unavailableReason, 'no_entitlement');
});

test('an HR-verified row wins for the entitlement and is flagged when it differs from the policy', async () => {
  const { service, repositories } = build({ records: [rec(U, '2026-11-02', 'sick')] });
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'vacation', { carryoverDays: 4 }));
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'sick', { entitlementDays: 90 }));
  const r = byType(await service.balance(U, FY));

  assert.deepEqual([r.vacation.source, r.vacation.status, r.vacation.totalDays, r.vacation.carryoverDays, r.vacation.remainingDays], ['hr_verified', 'ok', 14, 4, 14]);
  assert.deepEqual([r.sick.source, r.sick.totalDays, r.sick.usedDays, r.sick.remainingDays], ['hr_verified', 90, 1, 89]);
  assert.deepEqual(r.sick.flags.map((f) => f.code), ['hr_differs_from_policy']);
  assert.match(r.sick.flags[0].detail, /policy 60, HR 90/);
  assert.equal(r.personal.source, 'computed'); // no HR row for personal
});

test('a vacation row without a certified carry-over stays unknown', async () => {
  const { service, repositories } = build();
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'vacation'));
  const v = byType(await service.balance(U, FY)).vacation;
  assert.deepEqual([v.status, v.source, v.totalDays, v.remainingDays], ['unknown', 'hr_verified', null, null]);
  assert.deepEqual(v.missing, ['vacationCarryoverDays']);
});

test('an HR total above the vacation cap is kept and flagged', async () => {
  const { service, repositories } = build();
  await repositories.leaveHr.upsertProfile(profile(U, { continuousServiceStart: '2010-01-01' }));
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'vacation', { carryoverDays: 25 }));
  const v = byType(await service.balance(U, FY)).vacation;
  assert.equal(v.totalDays, 35);
  // the engine would cap 10 + 25 at 30; HR's 35 is kept, flagged as over the cap and as different from the policy
  assert.deepEqual(v.flags.map((f) => f.code), ['vacation_cap_exceeded', 'hr_differs_from_policy']);
  assert.match(v.flags[1].detail, /policy 30, HR 35/);
});

test('a missing hire date keeps personal leave unknown even though sick leave is computed', async () => {
  const { service } = build({ employees: [employee(U, 'university', { hireDate: null })] });
  const r = byType(await service.balance(U, FY));
  assert.deepEqual([r.personal.status, r.personal.totalDays, r.personal.remainingDays], ['unknown', null, null]);
  assert.deepEqual(r.personal.missing, ['hireDate']);
  assert.equal(r.sick.status, 'ok');
});

// ------------------------------------------------------------ eligibility

test('an unconfirmed type needs HR: no numbers, nothing deducted, still visible as recorded', async () => {
  const { service } = build({ records: [rec(D, '2026-11-02', 'sick')] });
  const rows = await service.balance(D, FY);
  for (const row of rows) {
    assert.deepEqual([row.status, row.source, row.totalDays, row.remainingDays, row.available], ['needs_hr', null, null, null, false]);
  }
  assert.equal(byType(rows).sick.usedDays, null);
});

test('an HR row settles a needs_hr type for that type only, with a flag', async () => {
  const { service, repositories } = build();
  await repositories.leaveHr.upsertEntitlement(hrRow(D, 'sick', { entitlementDays: 60 }));
  const r = byType(await service.balance(D, FY));
  assert.deepEqual([r.sick.source, r.sick.status, r.sick.totalDays], ['hr_verified', 'ok', 60]);
  assert.ok(r.sick.flags.some((f) => f.code === 'eligibility_from_hr_row'));
  assert.equal(r.personal.status, 'needs_hr'); // no row for it: still unconfirmed
  assert.equal(r.personal.totalDays, null);
});

test('outsourced staff and an explicit HR denial are never overridden by a stored number', async () => {
  const { service, repositories } = build();
  await repositories.leaveHr.upsertEntitlement(hrRow(C, 'sick', { entitlementDays: 60 }));
  const contract = byType(await service.balance(C, FY)).sick;
  assert.deepEqual([contract.status, contract.totalDays, contract.source], ['out_of_scope', null, null]);
  assert.ok(contract.flags.some((f) => f.code === 'hr_row_ignored_out_of_scope'));

  await repositories.leaveHr.upsertProfile(profile(U, { eligibilityConfirmed: false, eligibilityReference: 'memo 9' }));
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'sick', { entitlementDays: 60 }));
  assert.equal(byType(await service.balance(U, FY)).sick.status, 'out_of_scope');
});

// ------------------------------------------------------------ deduction

test('a day is deducted once: record + legacy of the same day, undecided days and leave_balance are ignored', async () => {
  const { service } = build({
    records: [
      rec(U, '2026-11-04', 'personal'),
      rec(U, '2026-11-05', 'personal', { approvalStatus: 'unverified' }),
      rec(U, '2026-11-06', 'personal', { approvalStatus: 'rejected' }),
      rec(U, '2026-11-09', 'personal', { reviewStatus: 'needs_review', dayPart: 'UNKNOWN', dayFraction: null }),
    ],
    legacy: [{ leaveId: 'L1', employeeUid: U, leaveType: 'personal', startDate: '2026-11-04', endDate: '2026-11-05', status: 'approved', matchStatus: 'matched' }],
    balances: [{ employeeUid: U, year: 2026, leaveType: 'personal', totalDays: 45, usedDays: 99, remainingDays: -54 }],
  });
  const p = byType(await service.balance(U, FY)).personal;
  // approved record on 11-04; the legacy row adds 11-05 (a day with a recorded row of any status is never added again)
  assert.equal(p.usedDays, 1);
  assert.equal(p.remainingDays, 44);
  assert.equal(p.pendingDays, 1);
});

test('the HR baseline counts once and records on or before its date are not deducted again', async () => {
  const { service, repositories } = build({
    records: [rec(U, '2026-11-10', 'sick'), rec(U, '2026-11-15', 'sick'), rec(U, '2026-11-20', 'sick'), rec(U, '2026-11-23', 'sick')],
    coverage: ['2026-11'], // October is not imported, but the baseline reaches past it
  });
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'sick', { entitlementDays: 60, usageBaselineDays: 5, usageBaselineThrough: '2026-11-15' }));
  const s = byType(await service.balance(U, FY)).sick;
  assert.equal(s.usedDays, 7); // 5 from HR + 11-20 + 11-23
  assert.equal(s.remainingDays, 53);
  assert.equal(s.usageComplete, true);
  assert.deepEqual(s.uncoveredMonths, []);
  assert.deepEqual(s.flags.map((f) => f.code), ['records_before_baseline_ignored']);
  assert.match(s.flags[0].detail, /2 approved record/);
});

test('without a baseline every approved record of the fiscal year is deducted', async () => {
  const { service, repositories } = build({ records: [rec(U, '2026-10-05', 'sick'), rec(U, '2026-11-10', 'sick')] });
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'sick', { entitlementDays: 60 }));
  assert.equal(byType(await service.balance(U, FY)).sick.usedDays, 2);
});

// ------------------------------------------------------------ coverage

test('a month that has begun but was never imported withholds the balance instead of overstating it', async () => {
  const { service } = build({ records: [rec(U, '2026-10-05', 'sick')], coverage: ['2026-10'] });
  const s = byType(await service.balance(U, FY)).sick;
  assert.equal(s.usageComplete, false);
  assert.deepEqual(s.uncoveredMonths, ['2026-11']); // December onwards has not begun
  assert.deepEqual([s.remainingDays, s.available, s.unavailableReason], [null, false, 'deductions_not_tracked']);
  assert.equal(s.usedDays, 1); // what is recorded is still shown
  assert.ok(s.reasons.includes('usage_coverage_incomplete'));
  assert.equal(s.status, 'ok');
});

// ------------------------------------------------------------ policy years

test('FY2569 is pending_policy without HR numbers: nothing is computed under the new announcement', async () => {
  const { service } = build({ records: [rec(U, '2026-03-02', 'sick')] });
  for (const row of await service.balance(U, 2569)) {
    assert.deepEqual([row.status, row.source, row.totalDays, row.usedDays, row.remainingDays, row.policyVersion], ['pending_policy', null, null, null, null, null]);
  }
});

test('FY2569 with HR-verified numbers counts the year\'s approved days without applying the new rules to them', async () => {
  const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const { service, repositories } = build({
    records: [rec(U, '2025-11-03', 'sick'), rec(U, '2026-03-02', 'vacation', { dayPart: 'AM', dayFraction: 0.5 })],
    coverage: [...months, ...COVERED_NOW],
  });
  await repositories.leaveHr.upsertEntitlement({ ...hrRow(U, 'sick', { entitlementDays: 60 }), fiscalYearBe: 2569 });
  await repositories.leaveHr.upsertEntitlement({ ...hrRow(U, 'vacation', { entitlementDays: 10, carryoverDays: 3 }), fiscalYearBe: 2569 });
  const r = byType(await service.balance(U, 2569));
  assert.deepEqual([r.sick.status, r.sick.source, r.sick.usedDays, r.sick.remainingDays], ['ok', 'hr_verified', 1, 59]);
  assert.ok(r.sick.flags.some((f) => f.code === 'policy_pending_hr_verified'));
  // a half-day vacation before 2026-08-21 is counted as recorded and NOT flagged under the 2026 clause 25
  assert.deepEqual([r.vacation.usedDays, r.vacation.remainingDays], [0.5, 12.5]);
  assert.equal(r.vacation.flags.some((f) => f.code === 'vacation_half_day_review'), false);
  assert.equal(r.personal.status, 'pending_policy');
});

test('half-day vacation after the effective date is kept as recorded and flagged', async () => {
  const { service, repositories } = build({ records: [rec(U, '2026-11-09', 'vacation', { dayPart: 'PM', dayFraction: 0.5 })] });
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'vacation', { carryoverDays: 0 }));
  const v = byType(await service.balance(U, FY)).vacation;
  assert.equal(v.usedDays, 0.5);
  assert.deepEqual(v.flags.map((f) => f.code), ['vacation_half_day_review']);
});

// ------------------------------------------------------------ no N+1

test('a balance is one fixed set of queries whatever the leave types', async () => {
  const { service, repositories } = build({ records: [rec(U, '2026-11-02', 'sick')] });
  await repositories.leaveHr.upsertEntitlement(hrRow(U, 'vacation', { carryoverDays: 0 }));
  const calls = {};
  const spy = (obj, name, label) => {
    const original = obj[name].bind(obj);
    obj[name] = async (...args) => { calls[label] = (calls[label] || 0) + 1; return original(...args); };
  };
  spy(repositories.employees, 'getLeaveFacts', 'facts');
  spy(repositories.leaveHr, 'getProfile', 'profile');
  spy(repositories.leaveHr, 'listEntitlements', 'entitlements');
  spy(repositories.leaveRecords, 'listForEmployee', 'records');
  spy(repositories.leaveRecords, 'coveredPeriods', 'coverage');
  spy(repositories.leave, 'list', 'legacy');
  await service.balance(U, FY);
  assert.deepEqual(calls, { facts: 1, profile: 1, entitlements: 1, records: 1, coverage: 1, legacy: 1 });
});

// ------------------------------------------------------------ leaveService: flag, basis, RBAC, shadow

function serviceWith(flag, repos, shadowLog) {
  const config = flag === undefined ? undefined : { leave: { entitlementEngine: flag } };
  return createLeaveService({ repositories: repos, config, shadowLog });
}
const as = (uid, role = 'user') => ({ employeeUid: uid, role });

test('the flag parses off | shadow | on and anything else is off', () => {
  assert.equal(leaveEngineFlag(undefined), 'off');
  assert.equal(leaveEngineFlag(''), 'off');
  assert.equal(leaveEngineFlag('maybe'), 'off');
  assert.equal(leaveEngineFlag('ON'), 'on');
  assert.equal(leaveEngineFlag(' Shadow '), 'shadow');
  assert.equal(leaveEngineFlag('off'), 'off');
});

test('flag off (or unset): a fiscal request is refused and the calendar balance is unchanged', async () => {
  const { repositories } = build({ balances: [{ employeeUid: U, year: 2026, leaveType: 'personal', totalDays: 45, usedDays: 0, remainingDays: 45 }] });
  for (const flag of [undefined, 'off']) {
    const service = serviceWith(flag, repositories);
    await assert.rejects(() => service.balance(as(U), U, FY, { basis: 'fiscal' }), (e) => e.status === 503 && e.code === 'LEAVE_ENTITLEMENT_ENGINE_OFF');
    const rows = await service.balance(as(U), U, 2026);
    assert.deepEqual(rows.find((r) => r.leaveType === 'personal'), {
      employeeUid: U, year: 2026, leaveType: 'personal', typeLabel: 'ลากิจ', totalDays: 45, usedDays: 0, pendingDays: 0, remainingDays: 45, available: true, unavailableReason: null,
    });
  }
});

test('calendar balances are byte-for-byte the same for off, shadow and on', async () => {
  const { repositories } = build({
    records: [rec(U, '2026-03-04', 'personal'), rec(U, '2026-03-05', 'personal', { approvalStatus: 'unverified' })],
    balances: [{ employeeUid: U, year: 2026, leaveType: 'personal', totalDays: 45, usedDays: 0, remainingDays: 45 }],
  });
  const logged = [];
  const off = await serviceWith('off', repositories).balance(as(U), U, 2026);
  const shadow = await serviceWith('shadow', repositories, (line) => logged.push(line)).balance(as(U), U, 2026);
  const on = await serviceWith('on', repositories).balance(as(U), U, 2026);
  assert.deepEqual(shadow, off);
  assert.deepEqual(on, off);
});

test('flag on: fiscal balances are served, validated and authorised like every other balance', async () => {
  const { repositories } = build({ employees: [employee(U, 'university'), employee(D, 'department')] });
  const service = serviceWith('on', repositories);
  const rows = await service.balance(as(U), U, FY, { basis: 'fiscal' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].basis, 'fiscal');

  await assert.rejects(() => service.balance(as(U), U, 2026, { basis: 'fiscal' }), (e) => e.status === 400); // a calendar year is not a fiscal year
  await assert.rejects(() => service.balance(as(U), U, 2570.5, { basis: 'fiscal' }), (e) => e.status === 400);
  await assert.rejects(() => service.balance(as(U), U, FY, { basis: 'weekly' }), (e) => e.status === 400);
  await assert.rejects(() => service.balance(as(U), D, FY, { basis: 'fiscal' }), (e) => e.status === 403); // someone else
});

test('shadow mode logs only statuses, after the response, and never changes it', async () => {
  const { repositories } = build({ records: [rec(U, '2026-11-02', 'sick')] });
  const logged = [];
  const service = serviceWith('shadow', repositories, (line) => logged.push(line));
  const before = logged.length;
  await service.balance(as(U), U, 2026);
  assert.equal(logged.length, before); // nothing synchronous
  await service.shadowSettled();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^leave-entitlement-shadow fy=\d{4} sick=\w+ personal=\w+ vacation=\w+$/);
  assert.equal(logged[0].includes(U), false);
  assert.equal(/\d+\.\d|=\d/.test(logged[0].replace(/fy=\d{4}/, '')), false); // no numbers beyond the year
});

test('shadow mode survives a failure and off never logs', async () => {
  const { repositories } = build();
  const broken = { ...repositories, employees: { findByUid: repositories.employees.findByUid.bind(repositories.employees) } }; // no getLeaveFacts
  const logged = [];
  const service = serviceWith('shadow', broken, (line) => logged.push(line));
  await service.balance(as(U), U, 2026); // the legacy answer still comes back
  await service.shadowSettled();
  assert.match(logged[0], /error$/);

  const quiet = [];
  const off = serviceWith('off', repositories, (line) => quiet.push(line));
  await off.balance(as(U), U, 2026);
  await off.shadowSettled();
  assert.deepEqual(quiet, []);
});

test('the controller defaults to the calendar year and only reads fiscal when asked', async () => {
  const seen = [];
  const controller = createLeaveController({ balance: async (...args) => { seen.push(args.slice(2)); return []; } });
  const run = (query) => new Promise((resolve, reject) => {
    const res = { status() { return this; }, json() { resolve(); return this; } };
    controller.balance({ auth: as(U), params: { employeeUid: U }, query }, res, reject);
  });
  await run({});
  await run({ year: '2026' });
  await run({ basis: 'fiscal', year: '2570' });
  await run({ basis: 'fiscal' });
  assert.equal(seen[0][1].basis, 'calendar');
  assert.equal(seen[0][0], new Date().getUTCFullYear());
  assert.deepEqual(seen[1], [2026, { basis: 'calendar' }]);
  assert.deepEqual(seen[2], [2570, { basis: 'fiscal' }]);
  assert.ok(seen[3][0] >= 2569 && seen[3][0] <= 2700);
});
