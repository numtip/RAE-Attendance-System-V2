const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');

// Fixture employees: one admin, two staff. Grants are injected per test, exactly as the existing
// authorization suite does, so this file never depends on the fixture grant table being populated.
const adminUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222';
const otherUid = '33333333-3333-3333-3333-333333333333';

// An executive needs an organization grant to hold data scope; without it every write is 403 and
// the tests would be asserting the wrong thing.
const EXEC_GRANT = { employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' };

function build({ grants = [EXEC_GRANT], memberships = [] } = {}) {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(employeeUid) {
      return grants.filter((grant) => grant.employeeUid === employeeUid);
    },
    async uidsInOrgUnits(codes) {
      const allowed = new Set(codes);
      return memberships.filter((row) => allowed.has(row.orgUnitCode)).map((row) => row.employeeUid);
    },
  };
  const service = createAttendanceRecordService({ repositories });
  return { repositories, service };
}

test('a late arrival is stored as late with the minutes and a calculated month', async () => {
  const { repositories, service } = build();
  const result = await service.recordDay(
    { role: 'EXECUTIVE', employeeUid: adminUid },
    staffUid,
    '2026-11-16',
    { checkIn: '08:31', checkOut: '16:30' },
  );

  assert.equal(result.status, 'late');
  assert.equal(result.isLate, true);
  assert.equal(result.lateMinutes, 1);
  assert.equal(result.computationStatus, 'calculated');
  assert.equal(result.ruleVersionCode, 'AR-0001');
  assert.equal(result.dayClassification, 'workday');

  const stored = await repositories.attendance.findForEmployee(staffUid);
  const day = stored.find((row) => row.date === '2026-11-16');
  assert.ok(day, 'the day must exist in the repository after a write');
  assert.equal(day.status, 'late');
});

test('on time is present, early departure keeps the early minutes, and the month is derived', async () => {
  const { repositories, service } = build();
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };

  await service.recordDay(auth, staffUid, '2026-11-16', { checkIn: '08:30', checkOut: '16:30' });
  const early = await service.recordDay(auth, staffUid, '2026-11-17', { checkIn: '08:30', checkOut: '16:29' });

  assert.equal(early.status, 'present');
  assert.equal(early.earlyMinutes, 1);
  assert.deepEqual(early.reasons, ['early_before_work_end']);

  const monthly = await repositories.attendance.findMonthly(staffUid, 2026, 11);
  assert.ok(monthly, 'the month must exist after a day write');
  assert.equal(monthly.totalPresent, 2);
  assert.equal(monthly.totalLate, 0);
  assert.equal(monthly.expectedWorkingDays, 21, 'November 2026 has 21 weekdays');
  assert.equal(monthly.computationStatus, 'calculated');
});

test('a weekend is a holiday and a day with no scan is pending, never absent', async () => {
  const { service } = build();
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };

  const saturday = await service.recordDay(auth, staffUid, '2026-11-21', { checkIn: '09:00', checkOut: '12:00' });
  assert.equal(saturday.status, 'holiday');
  assert.equal(saturday.dayClassification, 'weekend');

  const noScan = await service.recordDay(auth, staffUid, '2026-11-18', { leave: false, checkIn: null, checkOut: null })
    .catch((error) => error);
  assert.equal(noScan.code, 'VALIDATION_ERROR', 'a write with no fact at all is refused, not invented');
});

test('approved weekday holidays affect daily status and the monthly workday denominator', async () => {
  const { repositories, service } = build();
  repositories.attendanceHolidays = { async listApproved(start, end) {
    return ['2026-11-16', '2026-11-21'].filter((date) => date >= start && date <= end).map((date) => ({ date }));
  } };
  const result = await service.recordDay({ role: 'EXECUTIVE', employeeUid: adminUid }, staffUid,
    '2026-11-16', { checkIn: '08:41', checkOut: '16:30' });
  assert.equal(result.status, 'holiday');
  assert.equal(result.dayClassification, 'holiday');
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.monthly.expectedWorkingDays, 20);
});

test('an approved leave day is leave with its type', async () => {
  const { service } = build();
  const result = await service.recordDay(
    { role: 'EXECUTIVE', employeeUid: adminUid },
    staffUid,
    '2026-11-19',
    { leave: true, leaveType: 'sick' },
  );
  assert.equal(result.status, 'leave');
  assert.equal(result.lateMinutes, 0);
});

test('a year without an approved rule set is recorded as pending_policy, not guessed', async () => {
  const { repositories, service } = build();
  const result = await service.recordDay(
    { role: 'EXECUTIVE', employeeUid: adminUid },
    staffUid,
    '2027-01-05',
    { checkIn: '08:30', checkOut: '16:30' },
  );

  assert.equal(result.status, 'pending');
  assert.equal(result.computationStatus, 'pending_policy');
  assert.equal(result.ruleVersionCode, null, 'no rule version may be claimed for an unapproved year');

  const monthly = await repositories.attendance.findMonthly(staffUid, 2027, 1);
  assert.equal(monthly.computationStatus, 'pending_policy');
  assert.equal(monthly.expectedWorkingDays, null, 'an expected day count is not invented either');
});

test('a correction replaces the day instead of appending a second one', async () => {
  const { repositories, service } = build();
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };

  const first = await service.recordDay(auth, staffUid, '2026-11-16', { checkIn: '09:15', checkOut: '16:30' });
  const second = await service.recordDay(auth, staffUid, '2026-11-16', { checkIn: '08:30', checkOut: '16:30' });

  assert.equal(first.lateMinutes, 45);
  assert.equal(second.lateMinutes, 0);
  const stored = (await repositories.attendance.findForEmployee(staffUid)).filter((row) => row.date === '2026-11-16');
  assert.equal(stored.length, 1, 'the same employee-day must occupy exactly one row');
  assert.equal(stored[0].status, 'present');

  const monthly = await repositories.attendance.findMonthly(staffUid, 2026, 11);
  assert.equal(monthly.totalPresent, 1, 'the month reflects the corrected day, not both');
  assert.equal(monthly.totalLate, 0);
});

test('writing attendance for another person needs data scope', async () => {
  const body = { checkIn: '08:30', checkOut: '16:30' };

  // A staff member cannot author their own attendance record.
  const selfOnly = build({ grants: [] });
  await assert.rejects(
    () => selfOnly.service.recordDay({ role: 'EMPLOYEE', employeeUid: staffUid }, staffUid, '2026-11-16', body),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );

  // Admin is a directory role, not a data role: no data grant at all here.
  const adminOnly = build({ grants: [] });
  await assert.rejects(
    () => adminOnly.service.recordDay({ role: 'ADMIN', employeeUid: adminUid }, staffUid, '2026-11-16', body),
    (error) => error.status === 403,
  );

  // A manager whose org_unit grant covers the person may write.
  const manager = build({
    grants: [{ employeeUid: adminUid, role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'OU-SYN-1' }],
    memberships: [{ employeeUid: staffUid, orgUnitCode: 'OU-SYN-1' }],
  });
  const result = await manager.service.recordDay(
    { role: 'MANAGER', employeeUid: adminUid },
    staffUid,
    '2026-11-16',
    body,
  );
  assert.equal(result.status, 'present');

  // ... but not a person outside it.
  await assert.rejects(
    () => manager.service.recordDay({ role: 'MANAGER', employeeUid: adminUid }, otherUid, '2026-11-16', body),
    (error) => error.status === 403,
  );
});

test('input validation refuses a malformed day rather than storing it', async () => {
  const { service } = build();
  const auth = { role: 'EXECUTIVE', employeeUid: adminUid };
  const cases = [
    [{ checkIn: '8:35' }, /checkIn must be HH:MM/],
    [{ leave: true }, /leaveType is required/],
    [{ checkIn: '08:30', source: 'CSV_IMPORT' }, /source must be MANUAL_CORRECTION/],
    [{ checkIn: '08:30', note: 'x'.repeat(501) }, /at most 500/],
  ];
  for (const [body, pattern] of cases) {
    await assert.rejects(
      () => service.recordDay(auth, staffUid, '2026-11-16', body),
      (error) => error.status === 400 && pattern.test(error.message),
      `expected refusal for ${JSON.stringify(body)}`,
    );
  }

  await assert.rejects(
    () => service.recordDay(auth, staffUid, '16-11-2026', { checkIn: '08:30' }),
    (error) => error.status === 400 && /date must be YYYY-MM-DD/.test(error.message),
  );

  const unknown = await service.recordDay(auth, '99999999-9999-9999-9999-999999999999', '2026-11-16', {
    checkIn: '08:30',
  }).catch((error) => error);
  assert.equal(unknown.status, 404);
});
