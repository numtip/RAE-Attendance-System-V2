const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../src/services/facescanAttendanceIngestionService');

const adminUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222';
const otherUid = '33333333-3333-3333-3333-333333333333';
const EXEC_GRANT = { employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' };

function stagingRow(checkTime, index = 0) {
  return {
    id: 100 + index,
    importBatchUid: 'batch-1',
    sourceSystem: 'facescan_db',
    sourceEventKey: `key-${checkTime}-${index}`,
    facescanId: `fs-${index}`,
    checkTime,
    checkType: null,
    verifyCode: null,
    sensorId: 'sensor-1',
    workCode: null,
    employeeUid: staffUid,
    resolutionStatus: 'resolved',
  };
}

function build({ grants = [EXEC_GRANT], memberships = [], staging = [] } = {}) {
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
  repositories.attendanceEvents.seedResolvedStaging(staging);
  const recordService = createAttendanceRecordService({ repositories });
  const service = createFacescanAttendanceIngestionService({ repositories, recordService });
  return { repositories, service };
}

const exec = { role: 'EXECUTIVE', employeeUid: adminUid };

test('a single scan of the day is a check-in with no departure', async () => {
  const { service } = build({ staging: [stagingRow('2026-11-16T08:31:00')] });
  const result = await service.deriveDay(exec, staffUid, '2026-11-16');

  assert.equal(result.checkIn, '08:31');
  assert.equal(result.checkOut, null);
  assert.equal(result.status, 'late');
  assert.equal(result.lateMinutes, 1);
  assert.equal(result.earlyMinutes, 0, 'a lone arrival must not claim an early departure');
  assert.equal(result.eventCount, 1);
});

test('the earliest and latest scans become check-in and check-out', async () => {
  const { service } = build({
    staging: [
      stagingRow('2026-11-16T08:30:00', 0),
      stagingRow('2026-11-16T12:00:00', 1),
      stagingRow('2026-11-16T16:30:00', 2),
    ],
  });
  const result = await service.deriveDay(exec, staffUid, '2026-11-16');

  assert.equal(result.checkIn, '08:30');
  assert.equal(result.checkOut, '16:30');
  assert.equal(result.status, 'present');
  assert.equal(result.workDuration, 8);
  assert.equal(result.eventCount, 3);
});

test('a repeated scan in the same minute is not a zero-length day', async () => {
  const { service } = build({
    staging: [stagingRow('2026-11-16T08:30:00', 0), stagingRow('2026-11-16T08:30:00', 1)],
  });
  const result = await service.deriveDay(exec, staffUid, '2026-11-16');

  assert.equal(result.checkIn, '08:30');
  assert.equal(result.checkOut, null, 'two scans in the same minute are one arrival');
  assert.equal(result.earlyMinutes, 0);
});

test('promotion is idempotent: re-deriving the same day does not duplicate events', async () => {
  const { repositories, service } = build({
    staging: [stagingRow('2026-11-16T08:30:00', 0), stagingRow('2026-11-16T16:30:00', 1)],
  });

  await service.deriveDay(exec, staffUid, '2026-11-16');
  const first = await repositories.attendanceEvents.findDay(staffUid, '2026-11-16');
  await service.deriveDay(exec, staffUid, '2026-11-16');
  const second = await repositories.attendanceEvents.findDay(staffUid, '2026-11-16');

  assert.equal(second.length, first.length);
  assert.equal(second[0].eventUid, first[0].eventUid);
});

test('a day with no resolved scan is refused, never stored as absent', async () => {
  const { repositories, service } = build({ staging: [] });

  await assert.rejects(
    () => service.deriveDay(exec, staffUid, '2026-11-16'),
    (error) => error.status === 404 && error.code === 'NO_FACESCAN_EVENTS',
  );
  const stored = await repositories.attendance.findForEmployee(staffUid);
  assert.equal(stored.some((row) => row.date === '2026-11-16'), false,
    'the refused day must not exist; the fixture rows for other dates are irrelevant');
});

test('unmapped staging rows are not promoted', async () => {
  const unmapped = { ...stagingRow('2026-11-16T08:30:00'), resolutionStatus: 'unmapped' };
  const { service } = build({ staging: [unmapped] });

  await assert.rejects(
    () => service.deriveDay(exec, staffUid, '2026-11-16'),
    (error) => error.code === 'NO_FACESCAN_EVENTS',
  );
});

test('the derived day carries facescan provenance and its event count', async () => {
  const { repositories, service } = build({
    staging: [
      stagingRow('2026-11-16T08:30:00', 0),
      stagingRow('2026-11-16T12:00:00', 1),
      stagingRow('2026-11-16T16:30:00', 2),
    ],
  });
  await service.deriveDay(exec, staffUid, '2026-11-16');

  const rows = await repositories.attendance.findForEmployee(staffUid);
  const day = rows.find((row) => row.date === '2026-11-16');
  assert.equal(day.sourceSystem, 'FACESCAN');
  assert.equal(day.sourceEventCount, 3);
  assert.ok(day.firstEventAt instanceof Date);
  assert.equal(JSON.parse(day.reconciliation).source, 'FACESCAN');
});

test('the month is re-derived by the record service, not recomputed here', async () => {
  const { repositories, service } = build({
    staging: [stagingRow('2026-11-16T08:30:00', 0), stagingRow('2026-11-16T16:30:00', 1)],
  });
  await service.deriveDay(exec, staffUid, '2026-11-16');

  const monthly = await repositories.attendance.findMonthly(staffUid, 2026, 11);
  assert.equal(monthly.totalPresent, 1);
  assert.equal(monthly.expectedWorkingDays, 21, 'November 2026 has 21 weekdays');
});

test('the data-scope rule gates the derivation before anything is written', async () => {
  const staging = [stagingRow('2026-11-16T08:30:00')];

  const asEmployee = build({ grants: [], staging });
  await assert.rejects(
    () => asEmployee.service.deriveDay({ role: 'EMPLOYEE', employeeUid: staffUid }, staffUid, '2026-11-16'),
    (error) => error.status === 403,
  );
  assert.equal((await asEmployee.repositories.attendanceEvents.findDay(staffUid, '2026-11-16')).length, 0,
    'a refused caller must not create events as a side effect');

  const manager = build({
    grants: [{ employeeUid: adminUid, role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'OU-A' }],
    memberships: [{ employeeUid: staffUid, orgUnitCode: 'OU-A' }],
    staging,
  });
  await assert.rejects(
    () => manager.service.deriveDay({ role: 'MANAGER', employeeUid: adminUid }, otherUid, '2026-11-16'),
    (error) => error.status === 403,
  );
});

test('a malformed date is refused before any scope check or write', async () => {
  const { service } = build({ staging: [stagingRow('2026-11-16T08:30:00')] });
  await assert.rejects(
    () => service.deriveDay(exec, staffUid, '16-11-2026'),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
});
