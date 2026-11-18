// QA regressions found 2026-11-18. Each test reproduced its defect before the fix.
//
// The process timezone is pinned to UTC, which is what the deploy containers run with. A developer
// machine set to Asia/Bangkok hides the facescan provenance shift below, because a zone-less
// wall-clock string happens to parse correctly there.
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../src/services/facescanAttendanceIngestionService');
const engine = require('../src/domain/attendanceRuleEngine');

const adminUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222';
const EXEC_GRANT = { employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' };
const exec = { role: 'EXECUTIVE', employeeUid: adminUid };

function stagingRow(checkTime, index) {
  return {
    id: 500 + index,
    importBatchUid: 'batch-qa',
    sourceSystem: 'facescan_db',
    sourceEventKey: `qa-${checkTime}-${index}`,
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

function build(staging = []) {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(employeeUid) {
      return [EXEC_GRANT].filter((grant) => grant.employeeUid === employeeUid);
    },
    async uidsInOrgUnits() {
      return [];
    },
  };
  repositories.attendanceEvents.seedResolvedStaging(staging);
  const recordService = createAttendanceRecordService({ repositories });
  const facescan = createFacescanAttendanceIngestionService({ repositories, recordService });
  return { repositories, recordService, facescan };
}

test('QA-1: facescan first/last event instants are Bangkok wall clock, not process-local time', async () => {
  const { repositories, facescan } = build([
    stagingRow('2026-11-16T08:30:00', 0),
    stagingRow('2026-11-16T16:45:00', 1),
  ]);
  await facescan.deriveDay(exec, staffUid, '2026-11-16');

  const day = (await repositories.attendance.findForEmployee(staffUid))
    .find((row) => row.date === '2026-11-16');
  // 08:30 and 16:45 in Asia/Bangkok (UTC+7) are 01:30Z and 09:45Z.
  assert.equal(new Date(day.firstEventAt).toISOString(), '2026-11-16T01:30:00.000Z');
  assert.equal(new Date(day.lastEventAt).toISOString(), '2026-11-16T09:45:00.000Z');
  // The provenance must agree with the check-in/out the same write stored.
  assert.equal(new Date(day.firstEventAt).getTime(), new Date(day.checkIn).getTime());
  assert.equal(new Date(day.lastEventAt).getTime(), new Date(day.checkOut).getTime());
});

for (const date of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-06-31']) {
  test(`QA-2: a day that is not on the calendar (${date}) is refused, not rolled over`, async () => {
    const { repositories, recordService, facescan } = build([stagingRow(`${date}T08:30:00`, 0)]);

    await assert.rejects(
      () => recordService.recordDay(exec, staffUid, date, { checkIn: '08:30', checkOut: '16:30' }),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => facescan.deriveDay(exec, staffUid, date),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
    );
    const stored = await repositories.attendance.findForEmployee(staffUid);
    assert.equal(stored.some((row) => row.date === date), false, 'nothing may be written for it');
  });
}

test('QA-2: real calendar edges are still accepted', async () => {
  const { recordService } = build();
  for (const date of ['2026-01-31', '2026-02-28', '2026-04-30', '2026-12-31']) {
    const result = await recordService.recordDay(exec, staffUid, date, { leave: true, leaveType: 'personal' });
    assert.ok(['leave', 'holiday'].includes(result.status), `${date} -> ${result.status}`);
  }
});

test('QA-2: the rule engine refuses an impossible date instead of evaluating a rolled-over day', () => {
  // 2026-02-31 would otherwise be evaluated as Tuesday 2026-03-03.
  assert.throws(() => engine.evaluateDay({ date: '2026-02-31', checkIn: '08:30' }), { code: 'RULE_INPUT_INVALID' });
  assert.throws(() => engine.isoWeekday('2026-04-31'), { code: 'RULE_INPUT_INVALID' });
  assert.equal(engine.isoWeekday('2026-11-16'), 1);
});
