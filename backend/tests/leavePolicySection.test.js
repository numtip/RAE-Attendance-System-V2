const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEntitlements, policyContextFor, fiscalYearByBE } = require('../src/domain/leavePolicyEngine');
const { SECTION_EMPLOYEE_2569, SECTION_CONTRACT_2570_V3, FAMILIES, POLICY_FAMILY_BY_TYPE, familyForType } = require('../src/domain/leavePolicySection');
const { MJU_LEAVE_2569 } = require('../src/domain/leavePolicy2569');

const FY = 2570; // 2026-10-01 .. 2027-09-30
const OK = 'ok';
const CONFIRMED = { confirmed: true, reference: 'owner-confirmed 2026-11-23' };
const day = (date, leaveType, extra = {}) => ({ date, leaveType, dayPart: 'FULL', dayFraction: 1, status: 'approved', ...extra });
const run = (employee, options = {}) => computeEntitlements({ fiscalYear: FY, employee, ...options });
const figures = (res) => ['sick', 'personal', 'vacation'].map((t) => res.results[t].entitlementDays);
const statuses = (res) => ['sick', 'personal', 'vacation'].map((t) => res.results[t].status);

const SECTION = { employeeType: 'department', hireDate: '2015-04-01' };
const CONTRACT = { employeeType: 'contract', eligibilityConfirmation: CONFIRMED };

// ------------------------------------------------------------ policy data and the owner decision

test('policy values: university 60/45/10 untouched, section 15/5/10, section contract 10/5/10 (owner decision, personal is 5)', () => {
  assert.deepEqual([MJU_LEAVE_2569.sick.paidDaysPerFiscalYear, MJU_LEAVE_2569.personal.paidDaysPerFiscalYear, MJU_LEAVE_2569.vacation.daysPerFiscalYear], [60, 45, 10]);
  assert.deepEqual([SECTION_EMPLOYEE_2569.sick.paidDaysPerFiscalYear, SECTION_EMPLOYEE_2569.personal.paidDaysPerFiscalYear, SECTION_EMPLOYEE_2569.vacation.daysPerFiscalYear], [15, 5, 10]);
  assert.deepEqual([SECTION_CONTRACT_2570_V3.sick.paidDaysPerFiscalYear, SECTION_CONTRACT_2570_V3.personal.paidDaysPerFiscalYear, SECTION_CONTRACT_2570_V3.vacation.daysPerFiscalYear], [10, 5, 10]);
  assert.equal(SECTION_CONTRACT_2570_V3.id, 'RAE-SECTION-CONTRACT-2570-V3');
  assert.match(SECTION_CONTRACT_2570_V3.supersedes, /personal 10/);
  assert.equal(SECTION_CONTRACT_2570_V3.ownerDecisions[0].date, '2026-11-23');
  assert.match(SECTION_CONTRACT_2570_V3.ownerDecisions[0].decision, /personal 5/);
  assert.equal(SECTION_CONTRACT_2570_V3.effectiveFrom, '2026-10-01'); // owner decision: start of FY2570
  assert.equal(SECTION_CONTRACT_2570_V3.prorating, false);
  assert.equal(SECTION_CONTRACT_2570_V3.vacation.halfDayAllowed, true);
  assert.equal(SECTION_EMPLOYEE_2569.effectiveFrom, '2026-08-21');
  assert.equal(SECTION_CONTRACT_2570_V3.vacation.carryoverAllowed, false);
  assert.equal(SECTION_EMPLOYEE_2569.vacation.carryoverAllowed, false);
});

test('employment type -> policy family; procurement_academic has none', () => {
  assert.deepEqual(['university', 'department', 'contract', 'procurement_academic', 'unknown'].map(familyForType), ['university', 'section_employee', 'section_contract', null, null]);
  assert.equal(POLICY_FAMILY_BY_TYPE.procurement_academic, null);
  assert.deepEqual(Object.keys(FAMILIES), ['university', 'section_employee', 'section_contract']);
});

// ------------------------------------------------------------ university regression

test('university: 60/45/10 and the first-year / carry-over rules are unchanged', () => {
  const senior = run({ employeeType: 'university', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01' }, { carryover: { vacationDays: 4 } });
  assert.equal(senior.policyVersion, 'MJU-LEAVE-2569');
  assert.equal(senior.policyFamily, 'university');
  assert.deepEqual(figures(senior), [60, 45, 10]);
  assert.equal(senior.results.vacation.availableDays, 14);
  assert.equal(senior.results.vacation.carryoverDays, 4);
  // vacation carry-over still has to be supplied for a university person
  const noCarry = run({ employeeType: 'university', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01' });
  assert.deepEqual([noCarry.results.vacation.status, noCarry.results.vacation.missing], ['unknown', ['vacationCarryoverDays']]);
});

// ------------------------------------------------------------ section employees (S1)

test('section employee: 15/5/10, carry-over 0, and no university-only facts are needed', () => {
  const res = run(SECTION);
  assert.equal(res.policyVersion, 'RAE-SECTION-EMPLOYEE-2569');
  assert.deepEqual(statuses(res), [OK, OK, OK]);
  assert.deepEqual(figures(res), [15, 5, 10]);
  assert.equal(res.results.vacation.carryoverDays, 0);
  assert.equal(res.results.vacation.availableDays, 10);
  assert.deepEqual(res.results.sick.kind, 'paid_leave_allowance');
  assert.deepEqual(res.results.vacation.kind, 'leave_right');
  // no continuous-service date, no appointment kind, no carry-over were supplied and none is asked for
  for (const t of ['sick', 'personal', 'vacation']) assert.deepEqual(res.results[t].missing, []);
});

test('section employee without a hire date: sick leave is computed, personal and vacation need the hire date and nothing else', () => {
  const res = run({ employeeType: 'department', hireDate: null });
  assert.deepEqual(statuses(res), [OK, 'unknown', 'unknown']);
  assert.equal(res.results.sick.entitlementDays, 15);
  assert.deepEqual([res.results.personal.missing, res.results.vacation.missing], [['hireDate'], ['hireDate']]);
});

test('section employee tenure: under 3 months (personal) / 6 months (vacation) for the whole year is a determined "no right"', () => {
  const a = run({ employeeType: 'department', hireDate: '2027-07-01' }); // 3 months = 2027-10-01 > FY end
  assert.deepEqual([a.results.personal.status, a.results.personal.entitlementDays, a.results.personal.reasons], [OK, 0, ['service_under_3_months']]);
  assert.equal(a.results.vacation.entitlementDays, 0);
  assert.equal(a.results.sick.entitlementDays, 15); // sick leave has no tenure condition
  const b = run({ employeeType: 'department', hireDate: '2027-04-01' }); // 3 months passed in the year, 6 months = 2027-10-01 > FY end
  assert.equal(b.results.personal.status, 'pending_hr_decision');
  assert.deepEqual([b.results.vacation.status, b.results.vacation.entitlementDays, b.results.vacation.reasons], [OK, 0, ['service_under_6_months']]);
});

test('section employee: qualifying mid-year is not prorated by the engine: pending the owner, readings listed, no number', () => {
  const res = run({ employeeType: 'department', hireDate: '2026-09-20' }); // 3 months = 2026-12-20, 6 months = 2027-03-20: both inside FY2570
  for (const t of ['personal', 'vacation']) {
    const r = res.results[t];
    assert.equal(r.status, 'pending_hr_decision', t);
    assert.deepEqual(r.reasons, ['qualification_mid_year_pending_owner_decision']);
    assert.equal(r.entitlementDays, null);
    assert.equal(r.remainingDays, null);
    assert.equal(r.candidates.length, 2);
  }
  // already qualified before the year starts: the full right
  const full = run({ employeeType: 'department', hireDate: '2026-06-01' });
  assert.equal(full.results.personal.entitlementDays, 5);
  assert.equal(full.results.vacation.status, 'pending_hr_decision'); // 6 months = 2026-12-01, inside the year
  assert.equal(run({ employeeType: 'department', hireDate: '2026-03-31' }).results.vacation.entitlementDays, 10); // 6 months = 2026-09-30 <= FY start
});

test('section employee: hired after the fiscal year -> not started; FY2569 (the policy starts inside it) -> pending_policy', () => {
  assert.equal(run({ employeeType: 'department', hireDate: '2027-10-01' }).results.sick.status, 'not_started');
  const old = computeEntitlements({ fiscalYear: 2569, employee: SECTION });
  assert.deepEqual(statuses(old), ['pending_policy', 'pending_policy', 'pending_policy']);
  assert.equal(old.results.sick.entitlementDays, null);
});

// ------------------------------------------------------------ section contract (S2, owner decision)

test('section contract: 10 / 5 / 10 once confirmed, no hire date or any other fact needed, carry-over 0', () => {
  const res = run(CONTRACT);
  assert.equal(res.policyVersion, 'RAE-SECTION-CONTRACT-2570-V3');
  assert.equal(res.policyFamily, 'section_contract');
  assert.deepEqual(statuses(res), [OK, OK, OK]);
  assert.deepEqual(figures(res), [10, 5, 10]); // personal leave is 5 (owner decision 2026-11-23), not 10
  assert.equal(res.results.vacation.carryoverDays, 0);
  assert.equal(res.results.personal.kind, 'annual_limit'); // S2 does not say the days are paid: not called an allowance
  for (const t of ['sick', 'personal', 'vacation']) {
    assert.deepEqual(res.results[t].missing, []);
    assert.ok(!res.results[t].flags.some((f) => f.code === 'policy_effective_date_unspecified'), t);
  }
});

test('section contract: unconfirmed -> needs the owner (no numbers); explicitly declined -> out of scope', () => {
  const waiting = run({ employeeType: 'contract' }, { records: [day('2026-11-02', 'sick')] });
  assert.deepEqual(statuses(waiting), ['needs_hr', 'needs_hr', 'needs_hr']);
  assert.equal(waiting.results.sick.entitlementDays, null);
  assert.equal(waiting.results.sick.usedDays, null); // not deducted while unconfirmed
  assert.equal(waiting.results.sick.approvedRecordedDays, 1);
  assert.deepEqual(statuses(run({ employeeType: 'contract', eligibilityConfirmation: { confirmed: false, reference: 'owner decision' } })), ['out_of_scope', 'out_of_scope', 'out_of_scope']);
});

test('section contract: no backfill. Before FY2570 (2026-10-01) the policy does not apply -> pending_policy', () => {
  const old = computeEntitlements({ fiscalYear: 2569, employee: CONTRACT });
  assert.deepEqual(statuses(old), ['pending_policy', 'pending_policy', 'pending_policy']);
  assert.deepEqual(old.results.sick.reasons, ['no_policy_for_period']);
  assert.equal(old.policyVersion, null);
  // FY2571 (future) is calculated under the same figures
  assert.deepEqual(figures(computeEntitlements({ fiscalYear: 2571, employee: CONTRACT })), [10, 5, 10]);
});

test('section contract: a hire date after the fiscal year means not started; an earlier or missing one changes nothing', () => {
  assert.equal(run({ ...CONTRACT, hireDate: '2027-10-01' }).results.personal.status, 'not_started');
  assert.deepEqual(figures(run({ ...CONTRACT, hireDate: '2026-12-01' })), [10, 5, 10]); // no 3/6-month rule is borrowed from S1
});

// ------------------------------------------------------------ carry-over, usage, review flags

test('carry-over on file for a section policy is not added and says why; university keeps it', () => {
  for (const emp of [SECTION, CONTRACT]) {
    const r = run(emp, { carryover: { vacationDays: 3 } }).results.vacation;
    assert.equal(r.carryoverDays, 0);
    assert.equal(r.availableDays, 10);
    assert.ok(r.flags.some((f) => f.code === 'carryover_not_allowed' && /no vacation carry-over/.test(f.detail)));
  }
  assert.equal(run({ employeeType: 'university', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01' }, { carryover: { vacationDays: 3 } }).results.vacation.availableDays, 13);
});

test('only approved days are deducted; over the limit is reported, not changed', () => {
  const records = [
    day('2026-11-02', 'personal'), day('2026-11-03', 'personal', { status: 'unverified' }), day('2026-11-04', 'personal', { status: 'rejected' }),
    day('2026-11-05', 'personal', { status: 'needs_review' }),
  ];
  for (const emp of [SECTION, CONTRACT]) {
    const p = run(emp, { records }).results.personal;
    assert.deepEqual([p.usedDays, p.remainingDays, p.overAllowanceDays], [1, 4, 0], emp.employeeType);
  }
  const many = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'].map((d) => day(d, 'personal'));
  const over = run(CONTRACT, { records: many }).results.personal;
  assert.deepEqual([over.usedDays, over.remainingDays, over.overAllowanceDays], [6, 0, 1]); // 5 days is the contract limit
});

const sickRun = (employee, dates, extra = {}) => run(employee, { records: dates.map((d) => day(d, 'sick', extra)) }).results.sick.flags.filter((f) => f.code === 'medical_certificate_review');

test('medical certificate review: section employee at 3 working days, contract only above 3, never for university', () => {
  const three = ['2026-11-03', '2026-11-04', '2026-11-05']; // Tue-Thu
  assert.equal(sickRun(SECTION, ['2026-11-03', '2026-11-04']).length, 0);
  assert.equal(sickRun(SECTION, three).length, 1);
  assert.equal(sickRun(CONTRACT, three).length, 0); // 3 is not "more than 3"
  assert.equal(sickRun(CONTRACT, [...three, '2026-11-06']).length, 1); // 4
  // 3.5 days (three full days and a morning) is more than 3
  const half = run(CONTRACT, { records: [...three.map((d) => day(d, 'sick')), day('2026-11-06', 'sick', { dayPart: 'AM', dayFraction: 0.5 })] }).results.sick.flags;
  assert.equal(half.filter((f) => f.code === 'medical_certificate_review').length, 1);
  // university has its own (30 day) rule and gets no new flag
  const uni = { employeeType: 'university', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01' };
  assert.equal(sickRun(uni, three).length, 0);
});

test('medical certificate review: one continuous leave only (a weekend does not break it, a gap does); undecided days do not count', () => {
  assert.equal(sickRun(SECTION, ['2026-11-05', '2026-11-06', '2026-11-09']).length, 1); // Thu, Fri, Mon
  assert.equal(sickRun(SECTION, ['2026-11-03', '2026-11-05', '2026-11-09']).length, 0); // three separate days
  assert.equal(sickRun(SECTION, ['2026-11-03', '2026-11-04', '2026-11-05'], { status: 'unverified' }).length, 0);
  assert.equal(sickRun(SECTION, ['2026-11-03', '2026-11-04', '2026-11-05'], { status: 'rejected' }).length, 0);
});

test('vacation half-day: S1 minimum is 1 working day (flagged); contract staff may take 0.5 day (owner decision), counted as recorded', () => {
  const rec = [day('2026-11-04', 'vacation', { dayPart: 'AM', dayFraction: 0.5 })];
  assert.ok(run(SECTION, { records: rec }).results.vacation.flags.some((f) => f.code === 'vacation_half_day_review'));
  assert.ok(!run(CONTRACT, { records: rec }).results.vacation.flags.some((f) => f.code === 'vacation_half_day_review'));
  assert.equal(run(CONTRACT, { records: rec }).results.vacation.usedDays, 0.5); // counted as recorded, not rounded
  const quarter = [day('2026-11-04', 'vacation', { dayPart: 'AM', dayFraction: 0.25 })];
  assert.ok(run(CONTRACT, { records: quarter }).results.vacation.flags.some((f) => f.code === 'vacation_half_day_review')); // below 0.5 still reviewed
});

// ------------------------------------------------------------ policy lookup helper

test('policyContextFor: the family, the policy in force for a year and why none is', () => {
  const fy = (be) => fiscalYearByBE(be);
  assert.equal(policyContextFor('university', fy(2570)).policy.id, 'MJU-LEAVE-2569');
  assert.equal(policyContextFor('department', fy(2570)).policy.id, 'RAE-SECTION-EMPLOYEE-2569');
  assert.equal(policyContextFor('contract', fy(2570)).policy.id, 'RAE-SECTION-CONTRACT-2570-V3');
  assert.equal(policyContextFor('department', fy(2569)).reason, 'policy_effective_mid_year');
  assert.equal(policyContextFor('contract', fy(2569)).reason, 'no_policy_for_period');
  const unmapped = policyContextFor('procurement_academic', fy(2570));
  assert.deepEqual([unmapped.family, unmapped.unmapped], [null, true]);
});

test('an unmapped type (procurement_academic): waits until the owner confirms; once confirmed it keeps the university rules, flagged', () => {
  const waiting = run({ employeeType: 'procurement_academic', hireDate: '2015-04-01' });
  assert.deepEqual(statuses(waiting), ['needs_hr', 'needs_hr', 'needs_hr']);
  assert.equal(waiting.policyFamily, null);
  const confirmed = run({ employeeType: 'procurement_academic', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', eligibilityConfirmation: CONFIRMED });
  assert.equal(confirmed.results.sick.status, OK);
  assert.equal(confirmed.results.sick.entitlementDays, 60);
  assert.equal(confirmed.policyVersion, 'MJU-LEAVE-2569');
  assert.ok(confirmed.results.sick.flags.some((f) => f.code === 'policy_assumed_university'));
});
