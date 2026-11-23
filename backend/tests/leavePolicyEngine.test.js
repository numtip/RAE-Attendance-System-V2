const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = require('../src/domain/leavePolicyEngine');
const { MJU_LEAVE_2569, POLICIES } = require('../src/domain/leavePolicy2569');
const { salaryIncrementLeaveIndicator } = require('../src/domain/leaveSalaryIncrement');

// Same idiom as the other suites: resolve from a module, not `__dirname`.
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');

const { computeEntitlements, fiscalYearOf, fiscalYearByBE, policyForDate, summarizeUsage, STATUS } = engine;

const SENIOR = { employeeType: 'university', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01' };
const day = (date, leaveType, extra = {}) => ({ date, leaveType, dayPart: 'FULL', dayFraction: 1, status: 'approved', ...extra });
const FY70 = 2570; // 2026-10-01 .. 2027-09-30 (fully under the 2026-08-21 policy)

function entitlements(employee, extra = {}) {
  return computeEntitlements({ fiscalYear: FY70, employee, carryover: { vacationDays: 0 }, ...extra }).results;
}

// ------------------------------------------------------------ fiscal year

test('fiscal year runs 1 October to 30 September and is named by the Buddhist year it ends in', () => {
  assert.equal(fiscalYearOf('2026-09-30').be, 2569);
  assert.equal(fiscalYearOf('2026-10-01').be, 2570);
  assert.deepEqual(fiscalYearByBE(2569), { be: 2569, ce: 2026, start: '2025-10-01', end: '2026-09-30' });
  assert.deepEqual(fiscalYearByBE(2570), { be: 2570, ce: 2027, start: '2026-10-01', end: '2027-09-30' });
  assert.equal(fiscalYearOf('2027-02-28').be, 2570);
});

test('malformed or impossible dates are rejected, not coerced', () => {
  assert.throws(() => fiscalYearOf('2026-02-30'), TypeError);
  assert.throws(() => fiscalYearOf('26-01-01'), TypeError);
  assert.throws(() => fiscalYearByBE(2026), TypeError);
  assert.throws(() => computeEntitlements({ fiscalYear: FY70, employee: { employeeType: 'university', hireDate: '2020-13-01' } }), TypeError);
});

// ------------------------------------------------------------ policy versions and effective date

test('the 2569 policy applies from 2026-08-21; earlier dates have no policy on file', () => {
  assert.equal(policyForDate('2026-08-20'), null);
  assert.equal(policyForDate('2026-08-21').id, 'MJU-LEAVE-2569');
  assert.equal(MJU_LEAVE_2569.effectiveFrom, '2026-08-21');
  assert.ok(Object.isFrozen(MJU_LEAVE_2569) && Object.isFrozen(MJU_LEAVE_2569.vacation) && Object.isFrozen(POLICIES));
});

test('FY2569 starts before the policy and stays pending_policy; no balance is computed under the new rules', () => {
  const r = computeEntitlements({ fiscalYear: 2569, employee: SENIOR, carryover: { vacationDays: 3 }, records: [day('2026-03-02', 'sick')] });
  assert.equal(r.policyVersion, null);
  for (const type of ['sick', 'personal', 'vacation']) {
    const t = r.results[type];
    assert.equal(t.status, STATUS.PENDING_POLICY);
    assert.deepEqual(t.reasons, ['policy_effective_mid_year']);
    assert.equal(t.entitlementDays, null);
    assert.equal(t.remainingDays, null);
    assert.equal(t.usedDays, null);
  }
});

test('a year wholly before any policy is pending_policy with a different reason', () => {
  const r = computeEntitlements({ fiscalYear: 2568, employee: SENIOR });
  assert.equal(r.results.sick.status, STATUS.PENDING_POLICY);
  assert.deepEqual(r.results.sick.reasons, ['no_policy_for_period']);
});

test('FY2570 is fully under the 2569 policy', () => {
  const r = computeEntitlements({ fiscalYear: FY70, employee: SENIOR, carryover: { vacationDays: 0 } });
  assert.equal(r.policyVersion, 'MJU-LEAVE-2569');
  assert.equal(r.results.sick.status, STATUS.OK);
});

test('a later policy version is selected by its own effective date', () => {
  const next = { ...MJU_LEAVE_2569, id: 'MJU-LEAVE-NEXT', effectiveFrom: '2027-10-01' };
  const policies = [MJU_LEAVE_2569, next];
  assert.equal(policyForDate('2027-09-30', policies).id, 'MJU-LEAVE-2569');
  assert.equal(policyForDate('2027-10-01', policies).id, 'MJU-LEAVE-NEXT');
  const r = computeEntitlements({ fiscalYear: 2571, employee: SENIOR, carryover: { vacationDays: 0 }, policies });
  assert.equal(r.policyVersion, 'MJU-LEAVE-NEXT');
});

// ------------------------------------------------------------ employee type mapping

test('university staff are eligible', () => {
  const r = computeEntitlements({ fiscalYear: FY70, employee: SENIOR, carryover: { vacationDays: 0 } });
  assert.equal(r.eligibility.status, 'eligible');
});

test('unconfirmed types (department, procurement_academic, unknown) need HR; they are not ineligible and get no numbers', () => {
  for (const employeeType of ['department', 'procurement_academic', 'something_new', undefined]) {
    const res = entitlements({ employeeType, hireDate: '2015-04-01' }, { records: [day('2026-11-02', 'sick')] });
    for (const type of ['sick', 'personal', 'vacation']) {
      assert.equal(res[type].status, STATUS.NEEDS_HR, `${employeeType}/${type}`);
      assert.equal(res[type].entitlementDays, null);
      assert.equal(res[type].remainingDays, null);
      assert.equal(res[type].usedDays, null); // not deducted while eligibility is unconfirmed
    }
    assert.equal(res.sick.approvedRecordedDays, 1); // still visible, informationally
  }
});

test('outsourced contract staff are out of scope', () => {
  const res = entitlements({ employeeType: 'contract', hireDate: '2015-04-01' });
  assert.equal(res.sick.status, STATUS.OUT_OF_SCOPE);
});

test('an HR confirmation with a reference settles eligibility; one without a reference is ignored and flagged', () => {
  const confirmed = entitlements({ employeeType: 'department', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', eligibilityConfirmation: { confirmed: true, reference: 'HR memo 12/2569' } });
  assert.equal(confirmed.sick.status, STATUS.OK);
  const noRef = entitlements({ employeeType: 'department', hireDate: '2015-04-01', eligibilityConfirmation: { confirmed: true } });
  assert.equal(noRef.sick.status, STATUS.NEEDS_HR);
  assert.ok(noRef.sick.flags.some((f) => f.code === 'eligibility_confirmation_missing_reference'));
  const denied = entitlements({ employeeType: 'university', hireDate: '2015-04-01', eligibilityConfirmation: { confirmed: false, reference: 'HR memo' } });
  assert.equal(denied.sick.status, STATUS.OUT_OF_SCOPE);
});

// ------------------------------------------------------------ sick: allowance, not a limit

test('sick leave: 60 paid working days; the extra 60 is never automatic', () => {
  const s = entitlements(SENIOR).sick;
  assert.equal(s.kind, 'paid_leave_allowance');
  assert.equal(s.entitlementDays, 60);
  assert.equal(s.availableDays, 60);
  assert.equal(s.extensionGrantedDays, 0);
  assert.equal(s.absoluteLimitDays, null);
});

test('a rector-approved extension adds paid days; an out-of-range grant is refused', () => {
  assert.equal(entitlements(SENIOR, { grants: { sickExtensionDays: 30 } }).sick.availableDays, 90);
  assert.equal(entitlements(SENIOR, { grants: { sickExtensionDays: 60 } }).sick.availableDays, 120);
  assert.throws(() => entitlements(SENIOR, { grants: { sickExtensionDays: 61 } }), RangeError);
});

test('sick leave beyond the paid allowance is reported as over-allowance, never as absence', () => {
  const records = Array.from({ length: 70 }, (_, i) => day(engine.addDays('2026-10-01', i), 'sick'));
  const s = entitlements(SENIOR, { records }).sick;
  assert.equal(s.usedDays, 70);
  assert.equal(s.remainingDays, 0);
  assert.equal(s.overAllowanceDays, 10);
  assert.equal(JSON.stringify(s).toLowerCase().includes('absent'), false);
});

test('sick leave needs no hire date: its allowance does not depend on one', () => {
  const s = entitlements({ employeeType: 'university', hireDate: null }).sick;
  assert.equal(s.status, STATUS.OK);
  assert.equal(s.entitlementDays, 60);
});

// ------------------------------------------------------------ personal leave

test('personal leave: 45 paid working days for established staff', () => {
  const p = entitlements(SENIOR).personal;
  assert.equal(p.status, STATUS.OK);
  assert.equal(p.entitlementDays, 45);
  assert.equal(p.kind, 'paid_leave_allowance');
});

test('personal leave: a missing hire date is unknown, never a number', () => {
  const p = entitlements({ employeeType: 'university', hireDate: null }).personal;
  assert.equal(p.status, STATUS.UNKNOWN);
  assert.deepEqual(p.missing, ['hireDate']);
  assert.equal(p.entitlementDays, null);
  assert.equal(p.remainingDays, null);
});

test('personal leave: first year is 15 when service starts on 1 October of that fiscal year', () => {
  const p = entitlements({ employeeType: 'university', hireDate: '2026-10-01', continuousServiceStart: '2026-10-01' }).personal;
  assert.equal(p.status, STATUS.OK);
  assert.equal(p.entitlementDays, 15);
  assert.ok(p.reasons.includes('first_employment_year'));
});

test('personal leave: the year after an October start is 45', () => {
  const r = computeEntitlements({ fiscalYear: FY70, employee: { employeeType: 'university', hireDate: '2025-10-01', continuousServiceStart: '2025-10-01' }, carryover: { vacationDays: 0 } });
  assert.equal(r.results.personal.entitlementDays, 45);
});

test('personal leave: a mid-year start leaves first-year pending HR, with each reading shown', () => {
  const p = entitlements({ employeeType: 'university', hireDate: '2027-02-01', continuousServiceStart: '2027-02-01' }).personal;
  assert.equal(p.status, STATUS.PENDING_HR_DECISION);
  assert.equal(p.entitlementDays, null);
  assert.deepEqual(p.candidates.map((c) => c.entitlementDays), [15]);
  assert.equal(p.candidates[0].remainingDays, 15);
});

test('personal leave: the year after a mid-year start depends on the unresolved first-year reading', () => {
  const hired = { employeeType: 'university', hireDate: '2026-03-15' };
  const noContinuity = entitlements(hired).personal;
  assert.equal(noContinuity.status, STATUS.UNKNOWN);
  assert.deepEqual(noContinuity.missing, ['continuousServiceStart']);

  const converted = entitlements({ ...hired, continuousServiceStart: '2010-01-01' }).personal; // clause 62 continuity
  assert.equal(converted.status, STATUS.OK);
  assert.equal(converted.entitlementDays, 45);

  const fresh = entitlements({ ...hired, continuousServiceStart: '2026-03-15' }).personal;
  assert.equal(fresh.status, STATUS.PENDING_HR_DECISION);
  assert.deepEqual(fresh.candidates.map((c) => c.entitlementDays), [45, 15]);
});

test('personal leave: staff hired after the fiscal year ends are not_started', () => {
  const p = entitlements({ employeeType: 'university', hireDate: '2027-10-01' }).personal;
  assert.equal(p.status, STATUS.NOT_STARTED);
  assert.equal(p.entitlementDays, null);
});

test('personal leave: half a day counts as 0.5 and is not flagged', () => {
  const half = day('2026-11-02', 'personal', { dayPart: 'AM', dayFraction: 0.5 });
  const p = entitlements(SENIOR, { records: [half] }).personal;
  assert.equal(p.usedDays, 0.5);
  assert.equal(p.remainingDays, 44.5);
  assert.deepEqual(p.flags, []);
});

// ------------------------------------------------------------ vacation

test('vacation: 10 days plus a certified carry-over', () => {
  const v = entitlements(SENIOR, { carryover: { vacationDays: 4 } }).vacation;
  assert.equal(v.status, STATUS.OK);
  assert.equal(v.entitlementDays, 10);
  assert.equal(v.carryoverDays, 4);
  assert.equal(v.availableDays, 14);
  assert.equal(v.capDays, null); // 10 + 4 is under 20, so the 10-year question cannot matter
});

test('vacation: an unknown carry-over is unknown, never 0', () => {
  const v = computeEntitlements({ fiscalYear: FY70, employee: SENIOR }).results.vacation;
  assert.equal(v.status, STATUS.UNKNOWN);
  assert.deepEqual(v.missing, ['vacationCarryoverDays']);
  assert.equal(v.availableDays, null);
  assert.equal(v.remainingDays, null);
  const explicit = computeEntitlements({ fiscalYear: FY70, employee: SENIOR, carryover: { vacationDays: null } }).results.vacation;
  assert.equal(explicit.status, STATUS.UNKNOWN);
});

test('vacation: 10 + 15 carried, under 10 years of service -> capped at 20', () => {
  const employee = { employeeType: 'university', hireDate: '2020-01-01', continuousServiceStart: '2020-01-01', appointmentKind: 'first' };
  const v = entitlements(employee, { carryover: { vacationDays: 15 } }).vacation;
  assert.equal(v.status, STATUS.OK);
  assert.equal(v.capDays, 20);
  assert.equal(v.usableCarryoverDays, 10);
  assert.equal(v.availableDays, 20);
  assert.ok(v.reasons.includes('carryover_capped_at_20'));
});

test('vacation: 10 + 25 carried with 10 years of continuous service -> capped at 30', () => {
  const employee = { employeeType: 'university', hireDate: '2010-01-01', continuousServiceStart: '2010-01-01' };
  const v = entitlements(employee, { carryover: { vacationDays: 25 } }).vacation;
  assert.equal(v.capDays, 30);
  assert.equal(v.usableCarryoverDays, 20);
  assert.equal(v.availableDays, 30);
});

test('vacation: when the cap binds, missing continuity is unknown rather than a guessed cap', () => {
  const employee = { employeeType: 'university', hireDate: '2010-01-01' };
  const v = entitlements(employee, { carryover: { vacationDays: 25 } }).vacation;
  assert.equal(v.status, STATUS.UNKNOWN);
  assert.deepEqual(v.missing, ['continuousServiceStart']);
  assert.equal(v.availableDays, null);
});

test('vacation: ten years reached during the year leaves the cap pending HR with both readings', () => {
  const employee = { employeeType: 'university', hireDate: '2016-12-01', continuousServiceStart: '2016-12-01' };
  const v = entitlements(employee, { carryover: { vacationDays: 15 } }).vacation;
  assert.equal(v.status, STATUS.PENDING_HR_DECISION);
  assert.deepEqual(v.candidates.map((c) => c.availableDays), [20, 25]);
});

test('vacation: a missing hire date is unknown', () => {
  const v = entitlements({ employeeType: 'university', hireDate: null }).vacation;
  assert.equal(v.status, STATUS.UNKNOWN);
  assert.deepEqual(v.missing, ['hireDate']);
});

test('vacation clause 23: appointed in the year with under six months left gets no right that year', () => {
  const employee = { employeeType: 'university', hireDate: '2027-08-01', appointmentKind: 'first' };
  const v = entitlements(employee, { carryover: {} }).vacation;
  assert.equal(v.status, STATUS.OK);
  assert.equal(v.entitlementDays, 0); // a determined "no right", not a missing value
  assert.ok(v.reasons.includes('clause_23_under_six_months'));
  assert.equal(v.carryoverDays, 0); // a first appointment has nothing to carry
  assert.equal(v.availableDays, 0);
});

test('vacation clause 23: six months reached mid-year is pending HR; the right is not guessed', () => {
  const employee = { employeeType: 'university', hireDate: '2026-11-15', appointmentKind: 'rehire_after_resignation' };
  const v = entitlements(employee).vacation;
  assert.equal(v.status, STATUS.PENDING_HR_DECISION);
  assert.equal(v.entitlementDays, null);
  assert.ok(v.reasons.includes('six_months_reached_mid_year_pending_hr'));
});

test('vacation clause 23: the appointment kind is required when the hire date falls in the year', () => {
  const v = entitlements({ employeeType: 'university', hireDate: '2027-02-01' }).vacation;
  assert.equal(v.status, STATUS.UNKNOWN);
  assert.deepEqual(v.missing, ['appointmentKind']);
});

test('vacation: a mid-year start outside the clause 23 kinds has an unspecified partial-year allocation', () => {
  const v = entitlements({ employeeType: 'university', hireDate: '2027-02-01', appointmentKind: 'other' }).vacation;
  assert.equal(v.status, STATUS.PENDING_HR_DECISION);
  assert.deepEqual(v.reasons, ['partial_year_allocation_pending_hr']);
});

test('vacation: half a day is kept as recorded and flagged for review, not rounded', () => {
  const half = day('2026-11-09', 'vacation', { dayPart: 'PM', dayFraction: 0.5 });
  const v = entitlements(SENIOR, { records: [half], carryover: { vacationDays: 0 } }).vacation;
  assert.equal(v.usedDays, 0.5);
  assert.equal(v.remainingDays, 9.5);
  assert.deepEqual(v.flags.map((f) => f.code), ['vacation_half_day_review']);
});

test('vacation: the next year can only be offered a fully determined unused balance', () => {
  const ok = entitlements(SENIOR, { carryover: { vacationDays: 4 }, records: [day('2026-11-02', 'vacation'), day('2026-11-03', 'vacation')] }).vacation;
  assert.equal(ok.remainingDays, 12);
  assert.deepEqual(engine.vacationCarryoverForNextYear(ok), { status: STATUS.OK, days: 12 });
  const unknown = computeEntitlements({ fiscalYear: FY70, employee: SENIOR }).results.vacation;
  const next = engine.vacationCarryoverForNextYear(unknown);
  assert.equal(next.status, STATUS.UNKNOWN);
  assert.equal(next.days, null);
  assert.throws(() => engine.vacationCarryoverForNextYear(entitlements(SENIOR).sick), TypeError);
});

// ------------------------------------------------------------ what is deducted

test('only approved leave is deducted; recorded, awaiting, needs-review and rejected days are not', () => {
  const records = [
    day('2026-11-02', 'sick'),
    day('2026-11-03', 'sick', { status: 'unverified' }),
    day('2026-11-04', 'sick', { status: 'needs_review', dayFraction: null }),
    day('2026-11-05', 'sick', { status: 'rejected' }),
    day('2026-11-06', 'sick', { status: 'pending' }),
  ];
  const s = entitlements(SENIOR, { records }).sick;
  assert.equal(s.usedDays, 1);
  assert.equal(s.approvedRecordedDays, 1);
  assert.equal(s.remainingDays, 59);
});

test('leave outside the fiscal year or of another type is not counted', () => {
  const records = [day('2026-09-30', 'sick'), day('2027-10-01', 'sick'), day('2026-11-02', 'personal'), day('2026-11-02', 'other')];
  const res = entitlements(SENIOR, { records });
  assert.equal(res.sick.usedDays, 0);
  assert.equal(res.personal.usedDays, 1);
});

test('a calendar day is counted once per type: AM + PM = 1, duplicates and overlaps are flagged', () => {
  const am = day('2026-11-02', 'personal', { dayPart: 'AM', dayFraction: 0.5 });
  const pm = day('2026-11-02', 'personal', { dayPart: 'PM', dayFraction: 0.5 });
  assert.equal(summarizeUsage([am, pm], fiscalYearByBE(FY70), MJU_LEAVE_2569, 'personal').usedDays, 1);

  const dup = summarizeUsage([day('2026-11-03', 'sick'), day('2026-11-03', 'sick')], fiscalYearByBE(FY70), MJU_LEAVE_2569, 'sick');
  assert.equal(dup.usedDays, 1);
  assert.deepEqual(dup.flags.map((f) => f.code), ['duplicate_day_part']);

  const overlap = summarizeUsage([day('2026-11-04', 'sick'), day('2026-11-04', 'sick', { dayPart: 'AM', dayFraction: 0.5 })], fiscalYearByBE(FY70), MJU_LEAVE_2569, 'sick');
  assert.equal(overlap.usedDays, 1);
  assert.deepEqual(overlap.flags.map((f) => f.code), ['overlapping_day_parts']);
});

test('an approved record with an unusable fraction is flagged and not deducted', () => {
  const bad = summarizeUsage([day('2026-11-05', 'sick', { dayFraction: null }), day('2026-11-06', 'sick', { dayFraction: 2 })], fiscalYearByBE(FY70), MJU_LEAVE_2569, 'sick');
  assert.equal(bad.usedDays, 0);
  assert.deepEqual(bad.flags.map((f) => f.code), ['invalid_fraction', 'invalid_fraction']);
});

test('days before the policy effective date are not deducted under it', () => {
  const fy69 = fiscalYearByBE(2569);
  const u = summarizeUsage([day('2026-08-20', 'sick'), day('2026-08-21', 'sick')], fy69, MJU_LEAVE_2569, 'sick');
  assert.equal(u.usedDays, 1);
  assert.deepEqual(u.flags, [{ code: 'before_policy_effective', date: '2026-08-20' }]);
});

// ------------------------------------------------------------ clause 14

test('clause 14: an authorised special-event absence is not deducted', () => {
  const exempt = day('2026-11-09', 'personal', { nonDeductible: { clause: 14, authorizedBy: 'rector', reference: 'order 345/2569' } });
  const p = entitlements(SENIOR, { records: [exempt, day('2026-11-10', 'personal')] }).personal;
  assert.equal(p.approvedRecordedDays, 2);
  assert.equal(p.nonDeductibleDays, 1);
  assert.equal(p.usedDays, 1);
  assert.equal(p.remainingDays, 44);
});

test('clause 14: an exception without who authorised it and a reference is deducted and flagged', () => {
  const claims = [
    day('2026-11-09', 'sick', { nonDeductible: { clause: 14, authorizedBy: 'rector' } }),
    day('2026-11-10', 'sick', { nonDeductible: { clause: 14, reference: 'x' } }),
    day('2026-11-11', 'sick', { nonDeductible: { clause: 15, authorizedBy: 'rector', reference: 'x' } }),
  ];
  const s = entitlements(SENIOR, { records: claims }).sick;
  assert.equal(s.usedDays, 3);
  assert.equal(s.nonDeductibleDays, 0);
  assert.equal(s.flags.filter((f) => f.code === 'clause14_unauthorized').length, 3);
});

test('an exception never rescues a day that is not approved', () => {
  const r = day('2026-11-09', 'sick', { status: 'unverified', nonDeductible: { clause: 14, authorizedBy: 'rector', reference: 'x' } });
  const s = entitlements(SENIOR, { records: [r] }).sick;
  assert.equal(s.approvedRecordedDays, 0);
  assert.equal(s.nonDeductibleDays, 0);
});

// ------------------------------------------------------------ working days, continuous leave

test('sick leave across a weekend counts working days only; without a calendar the answer is unknown', () => {
  // Fri 2026-10-02 .. Tue 2026-10-06 = Fri, Sat, Sun, Mon, Tue
  assert.deepEqual(engine.workingDaysBetween('2026-10-02', '2026-10-06', { holidays: [] }), { status: STATUS.OK, days: 3 });
  assert.deepEqual(engine.workingDaysBetween('2026-10-02', '2026-10-06', { holidays: ['2026-10-05'] }), { status: STATUS.OK, days: 2 });
  const unknown = engine.workingDaysBetween('2026-10-02', '2026-10-06');
  assert.equal(unknown.status, STATUS.UNKNOWN);
  assert.equal(unknown.days, null);
  assert.deepEqual(unknown.missing, ['holidayCalendar']);
});

test('a continuous leave across the fiscal-year boundary is one request with per-year working days', () => {
  // Tue 2026-09-29 .. Fri 2026-10-02
  const split = engine.splitLeaveByFiscalYear('2026-09-29', '2026-10-02', { holidays: [] });
  assert.equal(split.requests, 1);
  assert.deepEqual(split.segments.map((s) => [s.fiscalYear, s.from, s.to, s.days]), [
    [2569, '2026-09-29', '2026-09-30', 2],
    [2570, '2026-10-01', '2026-10-02', 2],
  ]);
  assert.throws(() => engine.splitLeaveByFiscalYear('2026-10-02', '2026-09-29'), RangeError);
});

// ------------------------------------------------------------ salary increment stays separate

test('the salary-increment indicator is informational and independent of the leave balance', () => {
  const fy = fiscalYearByBE(FY70);
  const records = [
    ...Array.from({ length: 30 }, (_, i) => day(engine.addDays('2026-10-01', i), 'sick')),
    ...Array.from({ length: 16 }, (_, i) => day(engine.addDays('2027-01-01', i), 'personal')),
  ];
  const indicator = salaryIncrementLeaveIndicator(records, fy);
  assert.equal(indicator.combinedWorkingDays, 46);
  assert.equal(indicator.withinThreshold, false);
  assert.equal(indicator.authoritative, false);

  const res = entitlements(SENIOR, { records });
  assert.equal(res.sick.remainingDays, 30); // untouched by the 45-day increment note
  assert.equal(res.personal.remainingDays, 29);
  assert.equal(res.sick.status, STATUS.OK);

  const source = fs.readFileSync(path.join(backendRoot, 'src/domain/leavePolicyEngine.js'), 'utf8');
  assert.equal(/leaveSalaryIncrement/.test(source), false);
});

// ------------------------------------------------------------ boundary

test('Phase 1 is unwired: nothing under src outside the domain files uses the engine', () => {
  const root = path.join(backendRoot, 'src');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name) && !/leavePolicy(Engine|2569)\.js$|leaveSalaryIncrement\.js$/.test(entry.name)) {
        if (/leavePolicyEngine|leavePolicy2569|leaveSalaryIncrement/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    }
  }(root));
  assert.deepEqual(offenders, []);
});
