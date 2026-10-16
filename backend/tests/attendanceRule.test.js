process.env.DATA_SOURCE = 'fixture';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RULE_STATUS,
  SCHEDULE_STATUS,
  HOLIDAY_STATUS,
  HOLIDAY_SCOPE,
  COMPUTATION_STATUS,
  DAY_CLASSIFICATION,
  DEFAULT_RULE_CODES,
  parseTimeToMinutes,
  minutesToTimeString,
  normalizeEffectiveDate,
  isRuleEffectiveOn,
  isScheduleEffectiveOn,
  parsePolicyTokens,
  isWorkDay,
  normalizeRuleVersionInput,
  normalizeScheduleInput,
  normalizeHolidayInput,
  normalizeTimeRow,
} = require('../src/domain/attendanceRule');
const { createFixtureAttendanceRuleRepository } = require('../src/repositories/fixtureAttendanceRuleRepository');

const EMP_A = '11111111-1111-1111-1111-111111111111';
const EMP_B = '22222222-2222-2222-2222-222222222222';

function ruleInput(overrides = {}) {
  return {
    ruleVersionCode: 'AR-0001',
    name: 'Standard university shift',
    status: 'approved',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    workStart: '08:30',
    workEnd: '16:30',
    lateAfter: '08:30',
    earlyBefore: '16:30',
    approvedBy: 'hr-admin',
    approvedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function holidayInput(overrides = {}) {
  return {
    holidayDate: '2026-04-13',
    name: 'Songkran',
    scope: 'national',
    status: 'approved',
    sourceSystem: 'hr_calendar',
    approvedBy: 'hr-admin',
    approvedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

function scheduleInput(overrides = {}) {
  return {
    scheduleCode: 'SCH-0001',
    employeeUid: EMP_A,
    name: 'Morning shift',
    status: 'approved',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    workStart: '08:30',
    workEnd: '16:30',
    lateAfter: '08:30',
    earlyBefore: '16:30',
    workDays: [1, 2, 3, 4, 5],
    approvedBy: 'hr-admin',
    approvedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

// --- enums and time -----------------------------------------------------------

test('enum constants are frozen and match migration 022', () => {
  assert.deepEqual([...RULE_STATUS], ['draft', 'pending_approval', 'approved', 'retired']);
  assert.deepEqual([...SCHEDULE_STATUS], ['pending', 'approved', 'rejected']);
  assert.deepEqual([...HOLIDAY_STATUS], ['candidate', 'approved']);
  assert.deepEqual([...HOLIDAY_SCOPE], ['national', 'university', 'department']);
  assert.deepEqual([...COMPUTATION_STATUS], ['calculated', 'no_data', 'insufficient_data', 'pending_policy', 'failed']);
  assert.deepEqual([...DAY_CLASSIFICATION], ['workday', 'holiday', 'weekend']);
  assert.deepEqual(DEFAULT_RULE_CODES, { RULE: 'AR-0001' });
  for (const frozen of [RULE_STATUS, SCHEDULE_STATUS, HOLIDAY_STATUS, HOLIDAY_SCOPE, COMPUTATION_STATUS, DAY_CLASSIFICATION, DEFAULT_RULE_CODES]) {
    assert.equal(Object.isFrozen(frozen), true);
  }
});

test('parseTimeToMinutes and minutesToTimeString round-trip', () => {
  assert.equal(parseTimeToMinutes('08:30'), 510);
  assert.equal(parseTimeToMinutes('08:30:00'), 510);
  assert.equal(parseTimeToMinutes('00:00'), 0);
  assert.equal(parseTimeToMinutes('23:59:59'), 1439);
  assert.equal(minutesToTimeString(510), '08:30:00');
  assert.equal(minutesToTimeString(0), '00:00:00');
  assert.equal(minutesToTimeString(1439), '23:59:00');
  assert.equal(parseTimeToMinutes(minutesToTimeString(725)), 725);
});

test('parseTimeToMinutes rejects bad values without echoing them', () => {
  const bads = ['25:00', '08:60', '08:30:60', '8:30', 'half past eight', 'pii-marker-9900000000002'];
  for (const bad of bads) {
    assert.throws(
      () => parseTimeToMinutes(bad),
      (error) => error.status === 400
        && error.code === 'RULE_INVALID_TIME'
        && !String(error.message).includes(bad),
    );
  }
  assert.throws(() => parseTimeToMinutes(830), (error) => error.status === 400 && error.code === 'RULE_INVALID_TIME');
  assert.throws(() => parseTimeToMinutes(null), (error) => error.status === 400 && error.code === 'RULE_INVALID_TIME');
  assert.throws(() => minutesToTimeString(1440), (error) => error.status === 400 && error.code === 'RULE_INVALID_TIME');
  assert.throws(() => minutesToTimeString(-1), (error) => error.status === 400 && error.code === 'RULE_INVALID_TIME');
  assert.throws(() => minutesToTimeString('510'), (error) => error.status === 400 && error.code === 'RULE_INVALID_TIME');
});

// --- effective windows --------------------------------------------------------

test('isRuleEffectiveOn is inclusive on both ends and NULL means open', () => {
  const rule = { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' };
  assert.equal(isRuleEffectiveOn(rule, '2026-01-01'), true);
  assert.equal(isRuleEffectiveOn(rule, '2026-06-30'), true);
  assert.equal(isRuleEffectiveOn(rule, '2025-12-31'), false);
  assert.equal(isRuleEffectiveOn(rule, '2026-07-01'), false);
  assert.equal(isRuleEffectiveOn({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2099-01-01'), true);
  assert.equal(isRuleEffectiveOn(rule, null), true);
  assert.equal(isScheduleEffectiveOn(rule, '2026-06-30'), true);
  assert.equal(isScheduleEffectiveOn(rule, '2026-07-01'), false);
  assert.equal(isScheduleEffectiveOn(rule, null), true);
});

test('normalizeEffectiveDate delegates to the shared parser and rethrows as RULE_INVALID_DATE', () => {
  assert.equal(normalizeEffectiveDate('2026-07-01', 'effective_from'), '2026-07-01');
  assert.equal(normalizeEffectiveDate(new Date(Date.UTC(2026, 6, 1)), 'effective_from'), '2026-07-01');
  assert.equal(normalizeEffectiveDate(null, 'effective_from'), null);
  assert.equal(normalizeEffectiveDate('', 'effective_from'), null);
  assert.throws(
    () => normalizeEffectiveDate('2026-02-31', 'effective_from'),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_DATE',
  );
  assert.throws(
    () => normalizeEffectiveDate('pii-marker-9900000000002', 'effective_from'),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_DATE',
  );
});

// --- rule version normalization ----------------------------------------------

test('normalizeRuleVersionInput returns the canonical shape', () => {
  const normalized = normalizeRuleVersionInput(ruleInput({
    leaveTypesJson: ['vacation', 'sick'],
    leaveAliasesJson: { vac: 'leave' },
    businessStatusesJson: ['onsite'],
  }));
  assert.equal(normalized.ruleVersionCode, 'AR-0001');
  assert.equal(normalized.status, 'approved');
  assert.equal(normalized.effectiveFrom, '2026-01-01');
  assert.equal(normalized.effectiveTo, '2026-12-31');
  assert.equal(normalized.workStart, '08:30:00');
  assert.equal(normalized.workEnd, '16:30:00');
  assert.equal(normalized.lateAfter, '08:30:00');
  assert.equal(normalized.earlyBefore, '16:30:00');
  assert.equal(normalized.overnightShift, false);
  assert.equal(normalized.maxShiftSpanMinutes, 960);
  assert.equal(normalized.ignoreHolidays, true);
  assert.equal(normalized.leaveTypesJson, '["vacation","sick"]');
  assert.equal(normalized.leaveAliasesJson, '{"vac":"leave"}');
  assert.equal(normalized.businessStatusesJson, '["onsite"]');
  assert.ok(normalized.approvedAt instanceof Date);
  assert.equal(normalized.sourceOfTruth, null);
});

test('normalizeRuleVersionInput rejects each invalid field with its code', () => {
  const cases = [
    [{ ruleVersionCode: '' }, 'RULE_INVALID_CODE'],
    [{ ruleVersionCode: 'has space' }, 'RULE_INVALID_CODE'],
    [{ ruleVersionCode: 'A'.repeat(65) }, 'RULE_INVALID_CODE'],
    [{ name: '   ' }, 'RULE_INVALID_NAME'],
    [{ status: 'published' }, 'RULE_INVALID_STATUS'],
    [{ effectiveFrom: 'nope' }, 'RULE_INVALID_DATE'],
    [{ effectiveFrom: null }, 'RULE_INVALID_DATE'],
    [{ workStart: 'nope' }, 'RULE_INVALID_TIME'],
    [{ earlyBefore: null }, 'RULE_INVALID_TIME'],
    [{ maxShiftSpanMinutes: 0 }, 'RULE_INVALID_SPAN'],
    [{ maxShiftSpanMinutes: -5 }, 'RULE_INVALID_SPAN'],
    [{ maxShiftSpanMinutes: 'abc' }, 'RULE_INVALID_SPAN'],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => normalizeRuleVersionInput(ruleInput(override)),
      (error) => error.status === 400 && error.code === code,
    );
  }
});

test('normalizeRuleVersionInput rejects effective_to before effective_from', () => {
  assert.throws(
    () => normalizeRuleVersionInput(ruleInput({ effectiveFrom: '2026-07-01', effectiveTo: '2026-06-30' })),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_WINDOW',
  );
});

test('normalizeRuleVersionInput requires approved_by and approved_at for an approved rule', () => {
  for (const override of [{ approvedBy: null }, { approvedAt: null }, { approvedBy: '  ' }]) {
    assert.throws(
      () => normalizeRuleVersionInput(ruleInput(override)),
      (error) => error.status === 400 && error.code === 'RULE_INVALID_APPROVAL',
    );
  }
  assert.throws(
    () => normalizeRuleVersionInput(ruleInput({ approvedAt: 'not-a-time' })),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_DATE',
  );
  const draft = normalizeRuleVersionInput(ruleInput({
    ruleVersionCode: 'AR-0002', status: 'draft', approvedBy: null, approvedAt: null,
  }));
  assert.equal(draft.approvedBy, null);
  assert.equal(draft.approvedAt, null);
});

test('normalizeRuleVersionInput stores an earlier late_after without complaining (business policy)', () => {
  const normalized = normalizeRuleVersionInput(ruleInput({ ruleVersionCode: 'AR-0003', lateAfter: '08:00' }));
  assert.equal(normalized.lateAfter, '08:00:00');
  assert.equal(normalized.workStart, '08:30:00');
});

// --- policy tokens ------------------------------------------------------------

test('parsePolicyTokens accepts parsed arrays, JSON strings and null', () => {
  assert.deepEqual(
    parsePolicyTokens({ leaveTypesJson: ['vacation'], leaveAliasesJson: { vac: 'leave' }, businessStatusesJson: ['onsite'] }),
    { leaveTypes: ['vacation'], leaveAliases: { vac: 'leave' }, businessStatuses: ['onsite'], warnings: [] },
  );
  const fromStrings = parsePolicyTokens({
    leaveTypesJson: '["vacation"]',
    leaveAliasesJson: '{"vac":"leave"}',
    businessStatusesJson: '["onsite"]',
  });
  assert.deepEqual(fromStrings.leaveTypes, ['vacation']);
  assert.deepEqual(fromStrings.leaveAliases, { vac: 'leave' });
  assert.deepEqual(fromStrings.businessStatuses, ['onsite']);
  assert.deepEqual(fromStrings.warnings, []);

  const empty = { leaveTypes: [], leaveAliases: {}, businessStatuses: [], warnings: [] };
  assert.deepEqual(parsePolicyTokens({}), empty);
  assert.deepEqual(parsePolicyTokens(null), empty);
  assert.deepEqual(parsePolicyTokens({ leaveTypesJson: null, leaveAliasesJson: '', businessStatusesJson: undefined }), empty);
});

test('parsePolicyTokens never throws on malformed JSON and names the unreadable field', () => {
  const tokens = parsePolicyTokens({
    leaveTypesJson: '["vacation"',
    leaveAliasesJson: 'not json',
    businessStatusesJson: '"just a string"',
  });
  assert.deepEqual(tokens.leaveTypes, []);
  assert.deepEqual(tokens.leaveAliases, {});
  assert.deepEqual(tokens.businessStatuses, []);
  assert.equal(tokens.warnings.length, 3);
  assert.ok(tokens.warnings.some((warning) => warning.includes('leave_types_json')));
  assert.ok(tokens.warnings.some((warning) => warning.includes('leave_aliases_json')));
  assert.ok(tokens.warnings.some((warning) => warning.includes('business_statuses_json')));
});

// --- work days ----------------------------------------------------------------

test('isWorkDay uses ISO-8601 day numbers against real calendar dates', () => {
  // 2026-01-03 is a Saturday (ISO 7) and 2026-01-05 is a Monday (ISO 1).
  assert.equal(isWorkDay([1, 2, 3, 4, 5], '2026-01-05'), true);
  assert.equal(isWorkDay([1, 2, 3, 4, 5], '2026-01-02'), true);
  assert.equal(isWorkDay([1, 2, 3, 4, 5], '2026-01-03'), false);
  assert.equal(isWorkDay([6, 7], '2026-01-03'), true);
  assert.equal(isWorkDay([7], '2026-01-04'), true);
  assert.equal(isWorkDay([], '2026-01-05'), true);
  assert.equal(isWorkDay(undefined, '2026-01-03'), false);
  assert.throws(
    () => isWorkDay([1], '2026-02-31'),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_DATE',
  );
});

test('normalizeTimeRow coerces TIME columns and never invents a time', () => {
  const row = normalizeTimeRow({
    workStart: '08:30:00',
    workEnd: '16:30',
    lateAfter: { hours: 8, minutes: 30, seconds: 0 },
    earlyBefore: 'not-a-time',
    name: 'Morning shift',
  });
  assert.equal(row.workStart, '08:30:00');
  assert.equal(row.workEnd, '16:30:00');
  assert.equal(row.lateAfter, '08:30:00');
  assert.equal(row.earlyBefore, null);
  assert.equal(row.name, 'Morning shift');
  assert.equal(normalizeTimeRow(null), null);
});

// --- fixture rule versions ----------------------------------------------------

test('fixture: an approved rule is effective, an unapproved one is never assumed', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertRuleVersion(ruleInput());

  const effective = await repo.findEffectiveRuleVersion('2026-03-01');
  assert.equal(effective.ruleVersionCode, 'AR-0001');
  assert.equal(effective.workStart, '08:30:00');
  assert.equal(await repo.findEffectiveRuleVersion('2025-12-31'), null);

  const draftOnly = createFixtureAttendanceRuleRepository();
  await draftOnly.insertRuleVersion(ruleInput({ status: 'draft', approvedBy: null, approvedAt: null }));
  assert.equal(await draftOnly.findEffectiveRuleVersion('2026-03-01'), null);
  const diagnostic = await draftOnly.findEffectiveRuleVersionAnyStatus('2026-03-01');
  assert.equal(diagnostic.ruleVersionCode, 'AR-0001');
  assert.equal(diagnostic.status, 'draft');

  // A retired row is invisible to the engine but still readable by code.
  const retired = createFixtureAttendanceRuleRepository();
  await retired.insertRuleVersion(ruleInput({ status: 'retired', approvedBy: null, approvedAt: null }));
  assert.equal(await retired.findEffectiveRuleVersion('2026-03-01'), null);
  assert.equal((await retired.findRuleVersionByCode('AR-0001')).status, 'retired');
  assert.equal(await retired.findRuleVersionByCode('AR-9999'), null);
});

test('fixture: overlapping approved rules keep the ambiguity visible', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertRuleVersion(ruleInput({ ruleVersionCode: 'AR-0001', effectiveFrom: '2026-01-01' }));
  await repo.insertRuleVersion(ruleInput({ ruleVersionCode: 'AR-0002', effectiveFrom: '2026-06-01' }));

  const all = await repo.findEffectiveRuleVersions('2026-07-01');
  assert.deepEqual(all.map((row) => row.ruleVersionCode), ['AR-0002', 'AR-0001']);
  const picked = await repo.findEffectiveRuleVersion('2026-07-01');
  assert.equal(picked.ruleVersionCode, 'AR-0002');
  assert.equal((await repo.findEffectiveRuleVersions('2026-06-15')).length, 2);
});

test('fixture: insertRuleVersion rejects a duplicate code with 409', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertRuleVersion(ruleInput());
  await assert.rejects(
    () => repo.insertRuleVersion(ruleInput({ name: 'Another name' })),
    (error) => error.status === 409 && error.code === 'RULE_DUPLICATE_CODE',
  );
});

test('fixture: listRuleVersions filters by status, newest first, and rejects an unknown status', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertRuleVersion(ruleInput({ ruleVersionCode: 'AR-0001', effectiveFrom: '2026-01-01' }));
  await repo.insertRuleVersion(ruleInput({
    ruleVersionCode: 'AR-0002', effectiveFrom: '2026-06-01', status: 'draft', approvedBy: null, approvedAt: null,
  }));
  assert.deepEqual((await repo.listRuleVersions()).map((row) => row.ruleVersionCode), ['AR-0002', 'AR-0001']);
  assert.deepEqual((await repo.listRuleVersions({ status: 'draft' })).map((row) => row.ruleVersionCode), ['AR-0002']);
  await assert.rejects(
    () => repo.listRuleVersions({ status: 'nope' }),
    (error) => error.status === 400 && error.code === 'RULE_INVALID_STATUS',
  );
});

// --- fixture holidays ---------------------------------------------------------

test('fixture: listApprovedHolidays respects status, range and org unit scope', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-01-01', name: 'New Year' }));
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-04-13', name: 'Songkran' }));
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-07-01', name: 'University day', scope: 'university' }));
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-08-01', name: 'DEPT-01 day', scope: 'department', orgUnitCode: 'DEPT-01' }));
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-08-02', name: 'DEPT-02 day', scope: 'department', orgUnitCode: 'DEPT-02' }));
  await repo.insertHoliday(holidayInput({
    holidayDate: '2026-09-01', name: 'Candidate day', status: 'candidate', approvedBy: null, approvedAt: null,
  }));

  const all = await repo.listApprovedHolidays();
  assert.deepEqual(all.map((row) => row.holidayDate), ['2026-01-01', '2026-04-13', '2026-07-01']);

  const ranged = await repo.listApprovedHolidays({ from: '2026-04-13', to: '2026-07-01' });
  assert.deepEqual(ranged.map((row) => row.holidayDate), ['2026-04-13', '2026-07-01']);

  const forDept1 = await repo.listApprovedHolidays({ orgUnitCode: 'DEPT-01' });
  assert.deepEqual(forDept1.map((row) => row.name), ['New Year', 'Songkran', 'University day', 'DEPT-01 day']);

  const forDept2 = await repo.listApprovedHolidays({ orgUnitCode: 'DEPT-02' });
  assert.equal(forDept2.some((row) => row.name === 'DEPT-01 day'), false);
  assert.equal(forDept2.some((row) => row.name === 'DEPT-02 day'), true);
});

test('fixture: findHolidayOn prefers the longest scope and skips candidates', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-08-01', name: 'DEPT-01 day', scope: 'department', orgUnitCode: 'DEPT-01' }));
  await repo.insertHoliday(holidayInput({ holidayDate: '2026-08-01', name: 'University day', scope: 'university' }));

  assert.equal((await repo.findHolidayOn('2026-08-01', { orgUnitCode: 'DEPT-01' })).name, 'University day');
  assert.equal((await repo.findHolidayOn('2026-08-01')).name, 'University day');
  assert.equal(await repo.findHolidayOn('2026-08-02'), null);

  const deptOnly = createFixtureAttendanceRuleRepository();
  await deptOnly.insertHoliday(holidayInput({ holidayDate: '2026-08-01', name: 'DEPT-01 day', scope: 'department', orgUnitCode: 'DEPT-01' }));
  assert.equal(await deptOnly.findHolidayOn('2026-08-01', { orgUnitCode: 'DEPT-02' }), null);
  assert.equal((await deptOnly.findHolidayOn('2026-08-01', { orgUnitCode: 'DEPT-01' })).name, 'DEPT-01 day');
});

test('fixture: holidays reject duplicates and a department row without an org unit', async () => {
  const repo = createFixtureAttendanceRuleRepository();
  await repo.insertHoliday(holidayInput());
  await assert.rejects(
    () => repo.insertHoliday(holidayInput({ name: 'Second' })),
    (error) => error.status === 409 && error.code === 'HOLIDAY_DUPLICATE',
  );

  assert.throws(
    () => normalizeHolidayInput(holidayInput({ scope: 'department', orgUnitCode: null })),
    (error) => error.status === 400 && error.code === 'HOLIDAY_INVALID_ORG_UNIT',
  );
  assert.throws(
    () => normalizeHolidayInput(holidayInput({ scope: 'national', orgUnitCode: 'DEPT-01' })),
    (error) => error.status === 400 && error.code === 'HOLIDAY_INVALID_ORG_UNIT',
  );
  assert.throws(
    () => normalizeHolidayInput(holidayInput({ approvedBy: null })),
    (error) => error.status === 400 && error.code === 'HOLIDAY_INVALID_APPROVAL',
  );
});

// --- fixture schedules --------------------------------------------------------

test('fixture: findEffectiveSchedule ignores pending and rejected rows', async () => {
  const repo = createFixtureAttendanceRuleRepository({}, { employeeExists: (uid) => uid === EMP_A });
  await repo.insertSchedule(scheduleInput({ scheduleCode: 'SCH-0001', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', workDays: [1, 3, 5] }));
  await repo.insertSchedule(scheduleInput({
    scheduleCode: 'SCH-0002', effectiveFrom: '2026-07-01', status: 'pending', approvedBy: null, approvedAt: null,
  }));
  await repo.insertSchedule(scheduleInput({
    scheduleCode: 'SCH-0003', employeeUid: EMP_A, effectiveFrom: '2026-04-01', status: 'rejected', approvedBy: null, approvedAt: null,
  }));

  const approved = await repo.findEffectiveSchedule(EMP_A, '2026-03-01');
  assert.equal(approved.scheduleCode, 'SCH-0001');
  assert.deepEqual(approved.workDays, [1, 3, 5]);
  assert.equal(await repo.findEffectiveSchedule(EMP_A, '2026-08-15'), null);
  const diagnostic = await repo.findEffectiveScheduleAnyStatus(EMP_A, '2026-08-15');
  assert.equal(diagnostic.scheduleCode, 'SCH-0002');
  assert.equal(diagnostic.status, 'pending');
});

test('fixture: schedules enforce approval, work days, duplicates and the employee FK', async () => {
  const repo = createFixtureAttendanceRuleRepository({}, { employeeExists: (uid) => uid === EMP_A });

  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ approvedAt: null })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_APPROVAL',
  );
  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ workDays: [] })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_WORK_DAYS',
  );
  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ workDays: [1, 1] })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_WORK_DAYS',
  );
  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ workDays: [0, 8] })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_WORK_DAYS',
  );
  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ effectiveTo: '2025-12-31' })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_WINDOW',
  );
  assert.throws(
    () => normalizeScheduleInput(scheduleInput({ employeeUid: '   ', scheduleCode: 'SCH-0004' })),
    (error) => error.status === 400 && error.code === 'SCHEDULE_INVALID_EMPLOYEE',
  );

  await repo.insertSchedule(scheduleInput());
  await assert.rejects(
    () => repo.insertSchedule(scheduleInput({ name: 'Same code' })),
    (error) => error.status === 409 && error.code === 'SCHEDULE_DUPLICATE',
  );
  await assert.rejects(
    () => repo.insertSchedule(scheduleInput({ scheduleCode: 'SCH-0009' })),
    (error) => error.status === 409 && error.code === 'SCHEDULE_DUPLICATE',
  );
  await assert.rejects(
    () => repo.insertSchedule(scheduleInput({ scheduleCode: 'SCH-0010', employeeUid: EMP_B })),
    (error) => error.status === 404 && error.code === 'SCHEDULE_UNKNOWN_EMPLOYEE',
  );
});

// --- value-free messages ------------------------------------------------------

test('validator errors never echo the rejected value', () => {
  const marker = 'pii-marker-9900000000002';
  const throwers = [
    () => parseTimeToMinutes(marker),
    () => normalizeEffectiveDate(marker, 'effective_from'),
    () => normalizeRuleVersionInput(ruleInput({ name: marker.repeat(20) })),
    () => normalizeRuleVersionInput(ruleInput({ ruleVersionCode: `bad ${marker}` })),
    () => normalizeRuleVersionInput(ruleInput({ status: marker })),
    () => normalizeRuleVersionInput(ruleInput({ maxShiftSpanMinutes: marker })),
    () => normalizeScheduleInput(scheduleInput({ workDays: [marker] })),
    () => normalizeHolidayInput(holidayInput({ scope: marker })),
  ];
  for (const thrower of throwers) {
    assert.throws(thrower, (error) => error.status === 400 && !String(error.message).includes(marker));
  }
});
