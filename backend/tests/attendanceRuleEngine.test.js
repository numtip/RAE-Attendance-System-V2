/**
 * In-repo rule engine (D-10 groundwork) — boundary tests for the approved AR-0001 rules.
 *
 * The point of these tests is the EDGES: 08:30 exactly is not late, 16:30 exactly is not an early departure,
 * a weekend is not "no data", and a missing scan is not ABSENT. Those are the cases where two implementations
 * of the same policy silently disagree, which is the risk D-10 exists to settle.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { POLICY, STATUS, evaluateDay, minutesOfDay, isoWeekday } = require('../src/domain/attendanceRuleEngine');

// 2026-10-29 is a Thursday; 2026-10-31 a Saturday; 2026-11-01 a Sunday.
const WORKDAY = '2026-10-29';
const SATURDAY = '2026-10-31';

test('the policy is the approved AR-0001 set', () => {
  assert.equal(POLICY.version, 'AR-0001');
  assert.equal(POLICY.year, 2026);
  assert.equal(POLICY.workStart, '08:30');
  assert.equal(POLICY.workEnd, '16:30');
  assert.deepEqual([...POLICY.workdays], [1, 2, 3, 4, 5]);
});

test('a full day inside the window is present with no penalties', () => {
  const day = evaluateDay({ date: WORKDAY, checkIn: '08:00', checkOut: '17:00' });
  assert.equal(day.status, STATUS.PRESENT);
  assert.equal(day.lateMinutes, 0);
  assert.equal(day.earlyLeaveMinutes, 0);
  assert.equal(day.ruleVersion, 'AR-0001');
});

test('08:30 exactly is NOT late, 08:31 is late by one minute', () => {
  assert.equal(evaluateDay({ date: WORKDAY, checkIn: '08:30', checkOut: '16:30' }).status, STATUS.PRESENT);
  const late = evaluateDay({ date: WORKDAY, checkIn: '08:31', checkOut: '16:30' });
  assert.equal(late.status, STATUS.LATE);
  assert.equal(late.lateMinutes, 1);
});

test('16:30 exactly is NOT an early departure, 16:29 is by one minute', () => {
  assert.equal(evaluateDay({ date: WORKDAY, checkIn: '08:00', checkOut: '16:30' }).status, STATUS.PRESENT);
  const early = evaluateDay({ date: WORKDAY, checkIn: '08:00', checkOut: '16:29' });
  assert.equal(early.status, STATUS.EARLY_LEAVE);
  assert.equal(early.earlyLeaveMinutes, 1);
});

test('late AND early are reported together, not collapsed', () => {
  const day = evaluateDay({ date: WORKDAY, checkIn: '09:00', checkOut: '15:00' });
  assert.equal(day.status, STATUS.LATE_AND_EARLY_LEAVE);
  assert.equal(day.lateMinutes, 30);
  assert.equal(day.earlyLeaveMinutes, 90);
});

test('a weekend is a holiday, not missing data', () => {
  const saturday = evaluateDay({ date: SATURDAY, checkIn: '09:00', checkOut: '12:00' });
  assert.equal(saturday.status, STATUS.HOLIDAY);
  assert.equal(saturday.isWorkday, false);
});

test('no scan is no_data — never ABSENT, because the approved rules do not define absence', () => {
  const day = evaluateDay({ date: WORKDAY });
  assert.equal(day.status, STATUS.NO_DATA);
  assert.deepEqual(day.reasons, ['no_scan']);
});

test('a single scan is evaluated on the side it proves', () => {
  const inOnly = evaluateDay({ date: WORKDAY, checkIn: '08:10' });
  assert.equal(inOnly.status, STATUS.PRESENT);
  assert.equal(inOnly.earlyLeaveMinutes, 0, 'an absent check-out must not become an early departure');

  const outOnly = evaluateDay({ date: WORKDAY, checkOut: '15:00' });
  assert.equal(outOnly.status, STATUS.EARLY_LEAVE);
  assert.equal(outOnly.earlyLeaveMinutes, 90);
});

test('approved leave wins over any scan on the same day', () => {
  const day = evaluateDay({ date: WORKDAY, checkIn: '09:30', leave: true });
  assert.equal(day.status, STATUS.LEAVE);
});

test('a year without an approved rule set is refused, not guessed', () => {
  assert.throws(
    () => evaluateDay({ date: '2027-01-04', checkIn: '08:00' }),
    (error) => error.code === 'RULE_YEAR_NOT_APPROVED',
  );
});

test('malformed input is refused rather than coerced', () => {
  assert.throws(() => minutesOfDay('8:5'), (error) => error.code === 'RULE_INPUT_INVALID');
  assert.throws(() => minutesOfDay('24:00'), (error) => error.code === 'RULE_INPUT_INVALID');
  assert.throws(() => isoWeekday('29-10-2026'), (error) => error.code === 'RULE_INPUT_INVALID');
});

test('the weekday mapping is ISO (Monday = 1, Sunday = 7)', () => {
  assert.equal(isoWeekday(WORKDAY), 4);
  assert.equal(isoWeekday(SATURDAY), 6);
  assert.equal(isoWeekday('2026-11-01'), 7);
});
