const assert = require('node:assert/strict');
const test = require('node:test');

const { createOrganizationReportService } = require('../src/services/organizationReportService');
const { createDivisionReportService } = require('../src/services/divisionReportService');
const { DIVISIONS } = require('../src/config/organization');

const [OFFICE, RESEARCH, SERVICE] = DIVISIONS.map((d) => d.code);
const uid = (n) => `00000000-0000-0000-0000-00000000000${n}`;
const people = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  employeeUid: uid(n), employeeId: `10${n}`, firstNameTh: `ชื่อ${n}`, lastNameTh: `สกุล${n}`, department: 'x', status: 'active',
}));
// 1,2 office · 3 research · 4 service · 5 unassigned · 6 ambiguous (two divisions) · 7 other unit (ignored)
const memberships = [
  { employeeUid: uid(1), orgUnitCode: OFFICE }, { employeeUid: uid(2), orgUnitCode: OFFICE },
  { employeeUid: uid(3), orgUnitCode: RESEARCH }, { employeeUid: uid(4), orgUnitCode: SERVICE },
  { employeeUid: uid(6), orgUnitCode: OFFICE }, { employeeUid: uid(6), orgUnitCode: RESEARCH },
  { employeeUid: uid(7), orgUnitCode: 'SOME_OTHER_UNIT' },
];
const monthly = (n) => (n === 5 ? null : { totalWorkDays: 20, totalPresent: 10 + n, totalLate: n, totalLateMinutes: n * 10, totalLeave: 1 });

function build(grants) {
  const repositories = {
    authorization: {
      async grantsFor() { return grants; },
      async uidsInOrgUnits(codes) { return memberships.filter((m) => codes.includes(m.orgUnitCode)).map((m) => m.employeeUid); },
      async listMemberships() { return memberships; },
    },
    employees: { async list() { return people; } },
    attendance: { async findMonthly(u) { const n = Number(u.slice(-1)); return monthly(n); }, async latestDailyDate() { return '2026-03-31'; } },
    leaveRecords: {
      async coveredPeriods() { return ['2026-03']; },
      async listBetween() {
        const base = { leaveDate: '2026-03-04', reviewStatus: 'candidate', dayPart: 'FULL', dayFraction: 1, leaveType: 'sick' };
        return [
          { ...base, employeeUid: uid(1) },
          { ...base, employeeUid: uid(2), dayPart: 'PM', dayFraction: 0.5 },
          { ...base, employeeUid: uid(3), dayFraction: 1 },
          { ...base, employeeUid: uid(5), reviewStatus: 'needs_review', dayPart: 'UNKNOWN', dayFraction: null },
          { ...base, employeeUid: uid(6), dayFraction: 1 },
        ];
      },
    },
  };
  const organizationReportService = createOrganizationReportService({ repositories });
  return createDivisionReportService({ repositories, organizationReportService });
}
const exec = { role: 'executive', employeeUid: 'x' };
const execGrant = [{ employeeUid: 'x', role: 'EXECUTIVE', scopeType: 'organization' }];
const period = { year: '2026', month: '3' };

test('executive: three divisions + unassigned + ambiguous reconcile to organization totals', async () => {
  const report = await build(execGrant).divisions(exec, period);
  assert.equal(report.scope, 'organization');
  assert.deepEqual(report.divisions.map((d) => [d.code, d.headcount]), [[OFFICE, 2], [RESEARCH, 1], [SERVICE, 1]]);
  assert.equal(report.unassigned.headcount, 2, 'no membership and an unrelated unit are both unassigned');
  assert.equal(report.ambiguous.headcount, 1, 'two divisions is reported, not guessed');
  assert.equal(report.reconciliation.employeesInScope, 7);
  assert.equal(report.reconciliation.reconciled, true);
  const present = [...report.divisions, report.unassigned, report.ambiguous].reduce((t, b) => t + b.present, 0);
  assert.equal(present, report.totals.present);
  assert.equal(report.divisions[0].present, 11 + 12);
  assert.equal(report.divisions[0].avgPresentPerPerson, 11.5);
  assert.ok(report.divisions.every((d) => d.rows.every((row) => row.employeeUid === undefined)), 'uids are not exposed');
  assert.equal(report.unassigned.withoutData, 1, 'a missing monthly summary stays "no data"');
  // HIP-recorded leave rolls up per division in 0.5-day units; review items are counted apart, never summed
  assert.equal(report.recordedLeaveCovered, true);
  assert.equal(report.divisions[0].leaveRecordedDays, 1.5);
  assert.equal(report.unassigned.leaveNeedsReview, 1);
  assert.equal(report.ambiguous.leaveRecordedDays, 1);
  assert.equal(report.totals.leaveRecordedDays, 3.5);
});

test('manager sees only the granted division; other divisions and staff are absent', async () => {
  const grants = [{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: RESEARCH }];
  const report = await build(grants).divisions({ role: 'manager', employeeUid: 'm' }, period);
  assert.equal(report.scope, 'team');
  assert.deepEqual(report.divisions.map((d) => d.code), [RESEARCH]);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('ชื่อ1') && !text.includes('ชื่อ4'));
  assert.equal(report.reconciliation.reconciled, true);
});

test('an employee or an ungranted role is refused', async () => {
  await assert.rejects(() => build([]).divisions({ role: 'employee', employeeUid: uid(1) }, period), (e) => e.status === 403);
});

test('division names follow the HIP roster and codes are the RBAC org-unit codes', () => {
  assert.deepEqual(DIVISIONS.map((d) => d.nameTh), ['กองบริหารงานสำนักวิจัยฯ', 'กองบริหารงานวิจัย', 'กองบริหารงานบริการวิชาการ']);
});
