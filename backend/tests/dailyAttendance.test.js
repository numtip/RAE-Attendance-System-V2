const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureDailyAttendanceRepository } = require('../src/repositories/fixtureDailyAttendanceRepository');

// Synthetic data only. employee_uid values are shaped like real UUIDs, dates are 2026, event ids are 9001+.
const UID = '22222222-2222-2222-2222-222222222222';
const OTHER_UID = '33333333-3333-3333-3333-333333333333';
const MARKER = 'MARKER-9900000000002';

function baseInput(overrides = {}) {
  return {
    employeeUid: UID,
    date: '2026-03-02',
    checkIn: '08:01:00',
    checkOut: '17:30:00',
    isLate: true,
    lateMinutes: 1,
    earlyMinutes: 0,
    workDuration: 9.48,
    isLeave: false,
    leaveType: null,
    status: 'late',
    notes: 'synthetic notes',
    sourceSystem: 'facescan',
    ruleVersionCode: 'RULE-2026.1',
    scheduleCode: 'SCH-001',
    computationStatus: 'calculated',
    dayClassification: 'workday',
    isOvernight: false,
    sourceEventCount: 2,
    firstEventAt: '2026-03-02 08:01:00',
    lastEventAt: '2026-03-02 17:30:00',
    calculatedAt: '2026-03-02T10:05:00Z',
    reconciliationJson: { flags: ['tie-break'], candidates: 2 },
    sourceEventIds: [9001, 9002],
    ...overrides,
  };
}

test('full upsert round-trip keeps every provenance field and its type', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  const stored = await repo.upsertDay(baseInput());

  assert.equal(typeof stored.id, 'number');
  assert.equal(stored.employeeUid, UID);
  assert.equal(stored.date, '2026-03-02');
  assert.equal(stored.checkIn, '2026-03-02 08:01:00');
  assert.equal(stored.checkOut, '2026-03-02 17:30:00');
  assert.equal(stored.isLate, true);
  assert.equal(stored.lateMinutes, 1);
  assert.equal(stored.earlyMinutes, 0);
  assert.equal(stored.workDuration, 9.48);
  assert.equal(typeof stored.workDuration, 'number');
  assert.equal(stored.isLeave, false);
  assert.equal(stored.leaveType, null);
  assert.equal(stored.status, 'late');
  assert.equal(stored.notes, 'synthetic notes');
  assert.equal(stored.sourceSystem, 'facescan');
  assert.equal(stored.ruleVersionCode, 'RULE-2026.1');
  assert.equal(stored.scheduleCode, 'SCH-001');
  assert.equal(stored.computationStatus, 'calculated');
  assert.equal(stored.dayClassification, 'workday');
  assert.equal(stored.isOvernight, false);
  assert.equal(stored.sourceEventCount, 2);
  assert.equal(stored.firstEventAt, '2026-03-02 08:01:00');
  assert.equal(stored.lastEventAt, '2026-03-02 17:30:00');
  assert.equal(stored.calculatedAt, '2026-03-02T10:05:00.000Z');
  assert.deepEqual(stored.reconciliationJson, { flags: ['tie-break'], candidates: 2 });
  assert.equal(typeof stored.reconciliationJson, 'object');
  assert.deepEqual(stored.sourceEventIds, [9001, 9002]);
  assert.equal(typeof stored.createdAt, 'string');
  assert.equal(typeof stored.updatedAt, 'string');
});

test('upsert is idempotent: same input yields one row, an identical result and no duplicate links', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  const first = await repo.upsertDay(baseInput());
  const second = await repo.upsertDay(baseInput());

  assert.deepEqual(second, first);
  const { rows, links } = repo.all();
  assert.equal(rows.length, 1);
  assert.equal(links.length, 2);
});

test('recalculation with a different source-event set replaces the links (old ids are gone)', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  const first = await repo.upsertDay(baseInput());
  const second = await repo.upsertDay(baseInput({ sourceEventIds: [9003] }));

  assert.equal(second.id, first.id);
  const { rows, links } = repo.all();
  assert.equal(rows.length, 1);
  assert.deepEqual(links.map((link) => link.attendanceEventId), [9003]);
  assert.deepEqual(await repo.findSourceEventIds(UID, '2026-03-02'), [9003]);
});

test('upsert with an empty source-event set stores the row with no links', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  const stored = await repo.upsertDay(baseInput({ sourceEventIds: [] }));

  assert.deepEqual(stored.sourceEventIds, []);
  assert.equal(repo.all().rows.length, 1);
  assert.equal(repo.all().links.length, 0);
  assert.deepEqual(await repo.findSourceEventIds(UID, '2026-03-02'), []);
});

test('deleteForEmployeeDate removes the row and its links, and returns false for a missing day', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  await repo.upsertDay(baseInput());

  assert.equal(await repo.deleteForEmployeeDate(UID, '2026-03-02'), true);
  assert.equal(repo.all().rows.length, 0);
  assert.equal(repo.all().links.length, 0);
  assert.equal(await repo.deleteForEmployeeDate(UID, '2026-03-02'), false);
  assert.equal(await repo.findForEmployeeDate(UID, '2026-03-02'), null);
});

test('checkIn/checkOut: null stays null, a time is combined with the date, a full timestamp passes through', async () => {
  const repo = createFixtureDailyAttendanceRepository();

  const nulls = await repo.upsertDay(baseInput({ checkIn: null, checkOut: null }));
  assert.equal(nulls.checkIn, null);
  assert.equal(nulls.checkOut, null);

  const timeOnly = await repo.upsertDay(baseInput({
    date: '2026-03-03',
    checkIn: '07:45:00',
    checkOut: '16:15:00',
  }));
  assert.equal(timeOnly.checkIn, '2026-03-03 07:45:00');
  assert.equal(timeOnly.checkOut, '2026-03-03 16:15:00');

  const alreadyCombined = await repo.upsertDay(baseInput({
    date: '2026-03-04',
    checkIn: '2026-03-04 09:15:00',
    checkOut: '2026-03-05 01:30:00',
  }));
  assert.equal(alreadyCombined.checkIn, '2026-03-04 09:15:00');
  assert.equal(alreadyCombined.checkOut, '2026-03-05 01:30:00');
});

test('listForRange is inclusive on both ends and filters by employeeUid', async () => {
  const repo = createFixtureDailyAttendanceRepository();
  await repo.upsertDay(baseInput({ date: '2026-03-01' }));
  await repo.upsertDay(baseInput({ date: '2026-03-02' }));
  await repo.upsertDay(baseInput({ date: '2026-03-03' }));
  await repo.upsertDay(baseInput({ employeeUid: OTHER_UID, date: '2026-03-02' }));

  const range = await repo.listForRange({ from: '2026-03-02', to: '2026-03-03' });
  assert.deepEqual(range.map((row) => row.date), ['2026-03-02', '2026-03-03', '2026-03-02']);

  const filtered = await repo.listForRange({ employeeUid: UID, from: '2026-03-02', to: '2026-03-03' });
  assert.deepEqual(filtered.map((row) => row.date), ['2026-03-02', '2026-03-03']);
  assert.ok(filtered.every((row) => row.employeeUid === UID));

  const everything = await repo.listForRange({ from: '2026-01-01', to: '2026-12-31' });
  assert.equal(everything.length, 4);
  // Ordered by employee_uid then date.
  assert.deepEqual(everything.map((row) => `${row.employeeUid}:${row.date}`), [
    `${UID}:2026-03-01`,
    `${UID}:2026-03-02`,
    `${UID}:2026-03-03`,
    `${OTHER_UID}:2026-03-02`,
  ]);
});

test('validation rejects each bad field with its documented code and a value-free message', async () => {
  const repo = createFixtureDailyAttendanceRepository();

  const cases = [
    ['DAILY_INVALID_EMPLOYEE', baseInput({ employeeUid: [MARKER] })],
    ['DAILY_INVALID_EMPLOYEE', baseInput({ employeeUid: '' })],
    ['DAILY_INVALID_EMPLOYEE', baseInput({ employeeUid: null })],
    ['DAILY_INVALID_DATE', baseInput({ date: MARKER })],
    ['DAILY_INVALID_DATE', baseInput({ date: '2026-02-30' })],
    ['DAILY_INVALID_COUNT', baseInput({ lateMinutes: MARKER })],
    ['DAILY_INVALID_COUNT', baseInput({ earlyMinutes: -1 })],
    ['DAILY_INVALID_COUNT', baseInput({ sourceEventCount: MARKER })],
    ['DAILY_INVALID_DURATION', baseInput({ workDuration: MARKER })],
    ['DAILY_INVALID_DURATION', baseInput({ workDuration: -0.5 })],
    ['DAILY_INVALID_STATUS', baseInput({ status: MARKER })],
    ['DAILY_INVALID_LEAVE_TYPE', baseInput({ status: 'leave', leaveType: MARKER })],
    ['DAILY_INVALID_COMPUTATION_STATUS', baseInput({ computationStatus: MARKER })],
    ['DAILY_INVALID_SOURCE_EVENTS', baseInput({ sourceEventIds: MARKER })],
    ['DAILY_INVALID_SOURCE_EVENTS', baseInput({ sourceEventIds: [9001, 0] })],
    ['DAILY_INVALID_SOURCE_EVENTS', baseInput({ sourceEventIds: [9001, 1.5] })],
  ];

  for (const [code, input] of cases) {
    await assert.rejects(repo.upsertDay(input), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, 400);
      assert.ok(!String(error.message).includes(MARKER), `message leaked the rejected value: ${error.message}`);
      return true;
    });
  }
});

test('non-integer lateMinutes is rejected (1.5 and "5")', async () => {
  const repo = createFixtureDailyAttendanceRepository();

  for (const lateMinutes of [1.5, '5']) {
    await assert.rejects(repo.upsertDay(baseInput({ lateMinutes })), (error) => {
      assert.equal(error.code, 'DAILY_INVALID_COUNT');
      assert.ok(!String(error.message).includes(MARKER));
      return true;
    });
  }
});

test('initialRows seeds rows and their links for the range, find and delete paths', async () => {
  const repo = createFixtureDailyAttendanceRepository([
    {
      id: 7,
      employeeUid: UID,
      date: '2026-04-01',
      status: 'present',
      sourceEventIds: [9001, 9001, 9002],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  ]);

  const record = await repo.findForEmployeeDate(UID, '2026-04-01');
  assert.equal(record.id, 7);
  assert.deepEqual(record.sourceEventIds, [9001, 9002]);
  assert.equal(repo.all().links.length, 2);

  const created = await repo.upsertDay(baseInput({ date: '2026-04-02' }));
  assert.equal(created.id, 8);
});
