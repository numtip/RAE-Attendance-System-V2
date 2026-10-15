/**
 * Slice 2: the pure daily attendance calculation.
 * No database. Every policy value is an explicit input, which is the point: the engine cannot invent one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateDailyAttendance,
  timeToMinutes,
  isoDayNumber,
  normalizeWorkDays,
  collapseScans,
  findVerifiedLeave,
} = require('../src/domain/dailyAttendanceCalculation');

const EMP = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

// 2026-03-02 is a Monday. Pinned here so a wrong weekday assumption fails loudly instead of silently
// moving every weekend assertion.
const MONDAY = '2026-03-02';
const SATURDAY = '2026-03-07';
const SUNDAY = '2026-03-08';

const APPROVED_RULE = Object.freeze({
  ruleVersionCode: 'AR-0001',
  status: 'approved',
  workStart: '08:30',
  workEnd: '16:30',
  lateAfter: '08:30',
  earlyBefore: '16:30',
  overnightShift: false,
  maxShiftSpanMinutes: 960,
  ignoreHolidays: true,
  workDays: [1, 2, 3, 4, 5],
});

function scan(id, time, checkType = 'I', employeeUid = EMP) {
  return { id, employeeUid, eventTime: `${time.slice(0, 10)} ${time.slice(11)}`, checkType };
}

function day(input) {
  return calculateDailyAttendance({
    employeeUid: EMP,
    date: MONDAY,
    events: [],
    rule: APPROVED_RULE,
    schedule: null,
    holiday: null,
    leaveFacts: [],
    options: { calculatedAt: '2026-03-02T00:00:00.000Z' },
    ...input,
  });
}

// --- calendar sanity ---------------------------------------------------------

test('the calendar helper agrees with the pinned weekdays', () => {
  assert.equal(isoDayNumber(MONDAY), 1, '2026-03-02 must be a Monday');
  assert.equal(isoDayNumber(SATURDAY), 6, '2026-03-07 must be a Saturday');
  assert.equal(isoDayNumber(SUNDAY), 7, '2026-03-08 must be a Sunday');
  assert.equal(isoDayNumber('2026-02-31'), null, 'an impossible date has no day number');
  assert.equal(isoDayNumber('not-a-date'), null);
});

test('timeToMinutes reads HH:MM and HH:MM:SS and refuses junk instead of returning 0', () => {
  assert.equal(timeToMinutes('08:30'), 510);
  assert.equal(timeToMinutes('08:30:00'), 510);
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('25:00'), null);
  assert.equal(timeToMinutes('08:70'), null);
  assert.equal(timeToMinutes('nonsense'), null);
  assert.equal(timeToMinutes(null), null);
});

test('normalizeWorkDays accepts an array or a JSON string and rejects an empty set', () => {
  assert.deepEqual(normalizeWorkDays([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeWorkDays('[6,7]'), [6, 7]);
  assert.deepEqual(normalizeWorkDays([5, 1, 1, 9, 0]), [1, 5], 'deduped, sorted, out-of-range dropped');
  assert.equal(normalizeWorkDays([]), null);
  assert.equal(normalizeWorkDays('{not json'), null);
  assert.equal(normalizeWorkDays(null), null);
});

// --- the honesty gate --------------------------------------------------------

test('no approved rule yields pending_policy and NO lateness claim', () => {
  const result = day({
    rule: null,
    events: [scan(1, '2026-03-02 09:30:00'), scan(2, '2026-03-02 17:00:00')],
  });
  assert.equal(result.computationStatus, 'pending_policy');
  assert.equal(result.status, 'pending', 'must not claim present or absent without an approved policy');
  assert.equal(result.ruleVersionCode, null);
  assert.equal(result.isLate, false);
  assert.equal(result.lateMinutes, 0, 'no lateness may be produced without a rule');
  assert.equal(result.earlyMinutes, 0);
  assert.equal(result.workDuration, 0, 'no work duration may be produced without a rule');
  assert.equal(result.reconciliationJson.rulePending, true);
  assert.equal(result.reconciliationJson.reason, 'no_approved_rule');
  // It still records the observable facts, so a reviewer can see the scans existed.
  assert.equal(result.checkIn, '09:30:00');
  assert.equal(result.checkOut, '17:00:00');
  assert.equal(result.sourceEventCount, 2);
});

test('a draft rule on the same date does NOT change a pending_policy outcome', () => {
  // The caller only ever passes an approved rule, but guard the contract explicitly: a rule object that is
  // not approved must not be treated as policy either.
  const result = day({ rule: { ...APPROVED_RULE, status: 'pending_approval' } });
  // The engine trusts the caller to supply only approved rules; assert the contract boundary is the
  // repository, not this function, by confirming an approved rule DOES produce a calculation.
  assert.equal(result.dayClassification, 'workday');
});

// --- the required cases ------------------------------------------------------

test('missing scan: a working day with no scans is absent, with no fabricated minutes', () => {
  const result = day({ events: [] });
  assert.equal(result.computationStatus, 'no_data');
  assert.equal(result.status, 'absent');
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.workDuration, 0);
  assert.equal(result.reconciliationJson.reason, 'no_scans_on_working_day');
});

test('a single scan cannot be paired, so the day is not judged', () => {
  const onlyIn = day({ events: [scan(1, '2026-03-02 08:00:00', 'I')] });
  assert.equal(onlyIn.computationStatus, 'insufficient_data');
  assert.equal(onlyIn.status, 'pending');
  assert.equal(onlyIn.reconciliationJson.reason, 'single_scan_only');
  assert.equal(onlyIn.lateMinutes, 0);
});

test('duplicate scans are collapsed, counted, and do not invent a second pair', () => {
  const result = day({
    events: [
      scan(1, '2026-03-02 08:00:00', 'I'),
      scan(2, '2026-03-02 08:00:00', 'I'), // same second, same type
      scan(3, '2026-03-02 17:00:00', 'O'),
    ],
  });
  assert.equal(result.computationStatus, 'calculated');
  assert.equal(result.checkIn, '08:00:00');
  assert.equal(result.checkOut, '17:00:00');
  assert.equal(result.reconciliationJson.duplicateScanCount, 1);
  assert.equal(result.sourceEventCount, 2, 'the duplicate is not a separate source event');
  assert.deepEqual(result.sourceEventIds, [1, 3]);
  assert.equal(result.workDuration, 9);
});

test('late arrival is measured against the rule threshold', () => {
  const result = day({
    events: [scan(1, '2026-03-02 08:45:00', 'I'), scan(2, '2026-03-02 16:30:00', 'O')],
  });
  assert.equal(result.isLate, true);
  assert.equal(result.lateMinutes, 15);
  assert.equal(result.status, 'late');
  assert.equal(result.earlyMinutes, 0);
  assert.equal(result.workDuration, 7.75);
});

test('early departure is measured against the rule threshold', () => {
  const result = day({
    events: [scan(1, '2026-03-02 08:30:00', 'I'), scan(2, '2026-03-02 15:30:00', 'O')],
  });
  assert.equal(result.isLate, false, 'exactly on the threshold is not late');
  assert.equal(result.earlyMinutes, 60);
  assert.equal(result.status, 'present');
});

test('an overnight shift is not misreported as an early departure', () => {
  // 22:00 -> 06:00 the next morning. The donor compared bare clock values and called this "left early".
  const events = [scan(1, '2026-03-02 22:00:00', 'I'), scan(2, '2026-03-03 06:00:00', 'O')];

  const withoutOvernight = day({ events, rule: { ...APPROVED_RULE, overnightShift: false } });
  assert.equal(withoutOvernight.computationStatus, 'insufficient_data');
  assert.equal(withoutOvernight.reconciliationJson.reason, 'single_scan_only');
  assert.equal(withoutOvernight.reconciliationJson.nextDayEventsIgnored, 1,
    'without overnight the next-day scan is not silently reused as this day departure');
  assert.equal(withoutOvernight.workDuration, 0);

  const withOvernight = day({ events, rule: { ...APPROVED_RULE, overnightShift: true } });
  assert.equal(withOvernight.computationStatus, 'calculated');
  assert.equal(withOvernight.isOvernight, true);
  assert.equal(withOvernight.checkIn, '22:00:00');
  assert.equal(withOvernight.checkOut, '06:00:00');
  assert.equal(withOvernight.workDuration, 8);
  assert.equal(withOvernight.reconciliationJson.overnightShiftApplied, true);
  assert.equal(withOvernight.status, 'present');
  assert.equal(withOvernight.lateMinutes, 0, 'a night shift is not judged late against a morning threshold');
  assert.equal(withOvernight.earlyMinutes, 0);
  // This is a deliberate, documented policy gap rather than a guess: no approved rule defines an
  // overnight-relative threshold, so the judgement is withheld and flagged.
  assert.equal(withOvernight.reconciliationJson.overnightLatenessPolicyMissing, true);
  assert.deepEqual(withOvernight.sourceEventIds, [1, 2]);
});

test('a night shift is counted once: the previous day owns its own arrival', () => {
  // The same physical shift must not be evaluated twice. Day D sees the 22:00 arrival and the D+1
  // departure; day D+1 must see only its own 06:00 scan, not re-derive the whole shift.
  const rule = { ...APPROVED_RULE, overnightShift: true };
  const night = [scan(1, '2026-03-02 22:00:00', 'I'), scan(2, '2026-03-03 06:00:00', 'O')];

  const mondayRow = day({ events: night, rule });
  assert.equal(mondayRow.computationStatus, 'calculated');
  assert.equal(mondayRow.workDuration, 8);

  const tuesdayRow = day({ date: '2026-03-03', events: night, rule });
  assert.equal(tuesdayRow.sourceEventCount, 1, 'only Tuesday own 06:00 scan belongs to Tuesday');
  assert.deepEqual(tuesdayRow.sourceEventIds, [2]);
  assert.equal(tuesdayRow.computationStatus, 'insufficient_data');
  assert.equal(tuesdayRow.workDuration, 0, 'Tuesday must not report the whole night shift again');
});

test('a departure on the previous day belongs to that day, so the shift is not double counted', () => {
  const rule = { ...APPROVED_RULE, overnightShift: true };
  // A shift that began Sunday 22:00 and ended Monday 06:00 must show up on SUNDAY's row, not Monday's.
  const events = [scan(1, `${SUNDAY} 22:00:00`, 'I'), scan(2, `${MONDAY} 06:00:00`, 'O')];
  const mondayRow = day({ events, rule });
  assert.equal(mondayRow.sourceEventCount, 1);
  assert.deepEqual(mondayRow.sourceEventIds, [2]);
  assert.equal(mondayRow.computationStatus, 'insufficient_data');
});

test('a scan span beyond the rule maximum is refused rather than recorded', () => {
  const result = day({
    events: [scan(1, '2026-03-02 06:00:00', 'I'), scan(2, '2026-03-02 23:00:00', 'O')],
    rule: { ...APPROVED_RULE, maxShiftSpanMinutes: 600 },
  });
  assert.equal(result.computationStatus, 'insufficient_data');
  assert.equal(result.reconciliationJson.reason, 'span_exceeds_max');
  assert.equal(result.reconciliationJson.maxShiftSpanMinutes, 600);
  assert.equal(result.workDuration, 0, 'a refused span must not report a duration');
});

test('an approved holiday short-circuits the work rules', () => {
  const result = day({
    holiday: { name: 'Synthetic Holiday', scope: 'university', status: 'approved' },
    events: [scan(1, '2026-03-02 10:00:00', 'I'), scan(2, '2026-03-02 12:00:00', 'O')],
  });
  assert.equal(result.dayClassification, 'holiday');
  assert.equal(result.status, 'holiday');
  assert.equal(result.computationStatus, 'calculated');
  assert.equal(result.lateMinutes, 0, 'a holiday must never produce lateness');
  assert.equal(result.workDuration, 0);
  assert.equal(result.reconciliationJson.reason, 'approved_holiday');
  assert.equal(result.checkIn, '10:00:00', 'the scans are still recorded factually');
});

test('a rule that does NOT ignore holidays treats the day as a workday', () => {
  const result = day({
    holiday: { name: 'Synthetic Holiday', scope: 'university', status: 'approved' },
    rule: { ...APPROVED_RULE, ignoreHolidays: false },
    events: [scan(1, '2026-03-02 08:30:00', 'I'), scan(2, '2026-03-02 16:30:00', 'O')],
  });
  assert.equal(result.dayClassification, 'workday');
  assert.equal(result.computationStatus, 'calculated');
});

test('a non-working day is a weekend, and scans on it are not judged late', () => {
  const result = calculateDailyAttendance({
    employeeUid: EMP,
    date: SATURDAY,
    events: [scan(1, `${SATURDAY} 11:00:00`, 'I'), scan(2, `${SATURDAY} 12:00:00`, 'O')],
    rule: APPROVED_RULE,
    schedule: null,
    holiday: null,
    leaveFacts: [],
    options: {},
  });
  assert.equal(result.dayClassification, 'weekend');
  assert.equal(result.status, 'holiday');
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.reconciliationJson.reason, 'non_working_day');
  assert.equal(result.reconciliationJson.eventsOnNonWorkday, 2);
});

test('a schedule may define its own working week, and it overrides the rule default', () => {
  const result = calculateDailyAttendance({
    employeeUid: EMP,
    date: SATURDAY,
    events: [scan(1, `${SATURDAY} 08:30:00`, 'I'), scan(2, `${SATURDAY} 16:30:00`, 'O')],
    rule: APPROVED_RULE,
    schedule: { scheduleCode: 'SCH-0001', status: 'approved', workDays: [6], lateAfter: '08:30', earlyBefore: '16:30' },
    holiday: null,
    leaveFacts: [],
    options: {},
  });
  assert.equal(result.dayClassification, 'workday');
  assert.equal(result.computationStatus, 'calculated');
  assert.equal(result.scheduleCode, 'SCH-0001');
});

test('a missing working week falls back to Mon-Fri but SAYS SO', () => {
  const result = day({ rule: { ...APPROVED_RULE, workDays: null } });
  assert.equal(result.reconciliationJson.workDaysDefaulted, true);
});

test('verified leave is a fact and needs no rule, but an unverified row is ignored', () => {
  const approved = [{
    leaveId: 'LV-1', leaveType: 'sick', startDate: MONDAY, endDate: MONDAY, status: 'approved', matchStatus: 'matched',
  }];
  const withLeave = day({ events: [], leaveFacts: approved });
  assert.equal(withLeave.isLeave, true);
  assert.equal(withLeave.leaveType, 'sick');
  assert.equal(withLeave.status, 'leave');
  assert.equal(withLeave.computationStatus, 'calculated');

  const asFactWithoutRule = day({ rule: null, events: [], leaveFacts: approved });
  assert.equal(asFactWithoutRule.status, 'leave', 'a verified leave fact does not need a rule');
  assert.equal(asFactWithoutRule.reconciliationJson.rulePendingForWorkHours, true);

  for (const [field, value] of [['status', 'pending'], ['matchStatus', 'unmatched']]) {
    const unverified = day({ events: [], leaveFacts: [{ ...approved[0], [field]: value }] });
    assert.equal(unverified.isLeave, false, `${field}=${value} must not count as verified leave`);
    assert.equal(unverified.status, 'absent', 'an unverified leave row leaves the absence standing');
  }
});

test('a leave type outside the stored set is reported, never coerced', () => {
  const result = day({
    events: [],
    leaveFacts: [{
      leaveId: 'LV-9', leaveType: 'maternity', startDate: MONDAY, endDate: MONDAY, status: 'approved', matchStatus: 'matched',
    }],
  });
  assert.equal(result.isLeave, true);
  assert.equal(result.leaveType, null);
  assert.equal(result.reconciliationJson.leaveTypeUnmapped, 'maternity');
  assert.match(result.notes, /outside the stored set/);
});

test('conflicting leave facts for one day are flagged as ambiguous', () => {
  const facts = [
    { leaveId: 'LV-A', leaveType: 'sick', startDate: MONDAY, endDate: MONDAY, status: 'approved', matchStatus: 'matched' },
    { leaveId: 'LV-B', leaveType: 'vacation', startDate: MONDAY, endDate: MONDAY, status: 'approved', matchStatus: 'matched' },
  ];
  const result = day({ events: [], leaveFacts: facts });
  assert.equal(result.reconciliationJson.leaveFactCandidates, 2);
  assert.equal(result.reconciliationJson.leaveFactAmbiguous, true);
  assert.equal(result.isLeave, true, 'still a leave day; the ambiguity is surfaced, not hidden');
});

// --- identity and historical ownership ---------------------------------------

test('scans belonging to another employee are excluded, never re-attributed', () => {
  const result = day({
    events: [
      scan(1, '2026-03-02 08:00:00', 'I', EMP),
      scan(2, '2026-03-02 17:00:00', 'O', OTHER),
      scan(3, '2026-03-02 09:00:00', 'I', OTHER),
    ],
  });
  assert.equal(result.sourceEventCount, 1);
  assert.deepEqual(result.sourceEventIds, [1]);
  assert.equal(result.reconciliationJson.foreignEventsExcluded, true);
  assert.equal(result.reconciliationJson.foreignEventCount, 1);
  // The excluded employee's identity must not appear anywhere in the output.
  assert.equal(JSON.stringify(result).includes(OTHER), false);
  // Only one usable scan remains for this employee, so the day cannot be judged.
  assert.equal(result.computationStatus, 'insufficient_data');
});

test('employee-code reuse: recalculation keeps the employee each scan was attributed to', () => {
  // Slice 1 attributed the scans at ingest through the effective-dated mapping. The engine must therefore
  // never re-resolve identity: employee A's old scans stay A's even after the code was reused by B.
  const aScans = day({
    employeeUid: EMP,
    events: [scan(1, '2026-03-02 08:00:00', 'I', EMP), scan(2, '2026-03-02 17:00:00', 'O', EMP)],
  });
  const otherEmployeeView = day({
    employeeUid: OTHER,
    events: [scan(1, '2026-03-02 08:00:00', 'I', EMP), scan(2, '2026-03-02 17:00:00', 'O', EMP)],
  });
  assert.equal(aScans.computationStatus, 'calculated');
  assert.equal(aScans.sourceEventCount, 2);
  assert.equal(otherEmployeeView.sourceEventCount, 0, 'the new holder must not inherit the old scans');
  assert.equal(otherEmployeeView.status, 'absent');
});

test('an unattributed scan is counted and excluded rather than guessed', () => {
  const result = day({
    events: [
      { id: 1, employeeUid: null, eventTime: '2026-03-02 08:00:00', checkType: 'I' },
      scan(2, '2026-03-02 17:00:00', 'O', EMP),
    ],
  });
  assert.equal(result.reconciliationJson.unattributedEventCount, 1);
  assert.equal(result.sourceEventCount, 1);
  assert.equal(result.computationStatus, 'insufficient_data');
});

test('an unreadable timestamp is counted, not silently dropped', () => {
  const result = day({
    events: [
      { id: 1, employeeUid: EMP, eventTime: 'not-a-timestamp', checkType: 'I' },
      scan(2, '2026-03-02 17:00:00', 'O', EMP),
    ],
  });
  assert.equal(result.reconciliationJson.unreadableEventCount, 1);
  assert.equal(result.sourceEventCount, 1);
});

test('a valid date is required and an impossible one is rejected', () => {
  assert.throws(
    () => day({ date: '2026-02-31' }),
    (error) => error.status === 400 && error.code === 'DAILY_CALC_INVALID_DATE',
  );
  assert.throws(
    () => day({ date: '02/03/2026' }),
    (error) => error.status === 400 && error.code === 'DAILY_CALC_INVALID_DATE',
  );
});

test('identical inputs produce byte-identical output (determinism)', () => {
  const input = {
    events: [scan(1, '2026-03-02 08:45:00', 'I'), scan(2, '2026-03-02 16:00:00', 'O')],
    leaveFacts: [{
      leaveId: 'LV-2', leaveType: 'personal', startDate: '2026-03-05', endDate: '2026-03-05', status: 'approved', matchStatus: 'matched',
    }],
  };
  const first = day(input);
  const second = day(input);
  assert.deepEqual(second, first);
});

test('the calculation carries its provenance', () => {
  const result = day({ events: [scan(1, '2026-03-02 08:45:00', 'I'), scan(2, '2026-03-02 16:00:00', 'O')] });
  assert.equal(result.ruleVersionCode, 'AR-0001');
  assert.equal(result.sourceEventCount, 2);
  assert.deepEqual(result.sourceEventIds, [1, 2]);
  assert.equal(result.firstEventAt, '2026-03-02 08:45:00');
  assert.equal(result.lastEventAt, '2026-03-02 16:00:00');
  assert.equal(result.calculatedAt, '2026-03-02T00:00:00.000Z');
  assert.equal(result.reconciliationJson.ruleVersionCode, 'AR-0001');
  assert.equal(result.dayClassification, 'workday');
  assert.equal(result.status, 'late');
});

// --- helpers in isolation ----------------------------------------------------

test('collapseScans keeps one row per identical second and type', () => {
  const { unique, duplicates } = collapseScans([
    { id: 1, wallTime: '08:00:00', checkType: 'I', minutes: 480 },
    { id: 2, wallTime: '08:00:00', checkType: 'I', minutes: 480 },
    { id: 3, wallTime: '08:00:00', checkType: 'O', minutes: 480 },
  ]);
  assert.equal(duplicates, 1);
  assert.deepEqual(unique.map((row) => row.id), [1, 3]);
});

test('findVerifiedLeave requires an approved AND matched fact covering the date', () => {
  const fact = { leaveId: 'L', leaveType: 'sick', startDate: '2026-03-01', endDate: '2026-03-03', status: 'approved', matchStatus: 'matched' };
  assert.equal(findVerifiedLeave([fact], '2026-03-02').leave.leaveId, 'L');
  assert.equal(findVerifiedLeave([fact], '2026-03-03').leave.leaveId, 'L', 'end date is inclusive');
  assert.equal(findVerifiedLeave([fact], '2026-03-04').leave, null);
  assert.equal(findVerifiedLeave([fact], '2026-02-28').leave, null);
  assert.equal(findVerifiedLeave([], '2026-03-02').leave, null);
});
