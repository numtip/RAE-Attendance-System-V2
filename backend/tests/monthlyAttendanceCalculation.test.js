/**
 * Slice 3: the pure monthly aggregation.
 * No database. Every input is explicit, because the derivation must never invent a policy or a number.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateMonthlySummary,
  enumerateMonthDays,
  daysInMonth,
  isoDayNumber,
  monthKeyOf,
  dayKeyOf,
  MONTH_COMPUTATION_STATUS,
} = require('../src/domain/monthlyAttendanceCalculation');

const EMP = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

// March 2026: 31 days, and exactly 22 weekdays (Mar 2-6, 9-13, 16-20, 23-27, 30-31).
const YEAR = 2026;
const MONTH = 3;

const WEEK = [1, 2, 3, 4, 5];

/** One calendar entry per day of the month, all covered by an approved Mon-Fri rule, no holidays. */
function calendarFor(year, month, { rule = { workDays: WEEK, ignoreHolidays: true }, holidayDates = [] } = {}) {
  return enumerateMonthDays(year, month).map((date) => ({
    date,
    rule,
    holiday: holidayDates.includes(date),
  }));
}

function dailyRow(overrides = {}) {
  return {
    employeeUid: EMP,
    date: `${YEAR}-03-02`,
    status: 'present',
    computationStatus: 'calculated',
    dayClassification: 'workday',
    lateMinutes: 0,
    earlyMinutes: 0,
    workDuration: 0,
    ruleVersionCode: 'AR-0001',
    ...overrides,
  };
}

function derive(overrides = {}) {
  return calculateMonthlySummary({
    employeeUid: EMP,
    year: YEAR,
    month: MONTH,
    dailyRows: [],
    calendar: calendarFor(YEAR, MONTH),
    calculatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

// --- calendar helpers --------------------------------------------------------

test('month enumeration is correct, including leap years', () => {
  assert.equal(daysInMonth(2026, 2), 28, '2026 is not a leap year');
  assert.equal(daysInMonth(2028, 2), 29, '2028 IS a leap year');
  assert.equal(daysInMonth(2026, 3), 31);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(enumerateMonthDays(2026, 2).length, 28);
  assert.equal(enumerateMonthDays(2028, 2).length, 29);
  assert.equal(enumerateMonthDays(2026, 3)[0], '2026-03-01');
  assert.equal(enumerateMonthDays(2026, 3)[30], '2026-03-31');
});

test('isoDayNumber matches the real calendar for the pinned month', () => {
  assert.equal(isoDayNumber('2026-03-01'), 7, '2026-03-01 is a Sunday');
  assert.equal(isoDayNumber('2026-03-02'), 1, '2026-03-02 is a Monday');
  assert.equal(isoDayNumber('2026-03-07'), 6, '2026-03-07 is a Saturday');
  assert.equal(isoDayNumber('2026-02-30'), null, 'an impossible date has no day number');
});

test('monthKeyOf and dayKeyOf accept a Date as well as a string', () => {
  assert.equal(monthKeyOf('2026-03-02'), '2026-03');
  assert.equal(monthKeyOf(new Date('2026-03-02T00:00:00.000Z')), '2026-03');
  assert.equal(dayKeyOf(new Date('2026-03-02T00:00:00.000Z')), '2026-03-02');
  assert.equal(dayKeyOf('2026-03-02 08:00:00'), '2026-03-02');
  assert.equal(dayKeyOf('nonsense'), null);
  assert.equal(monthKeyOf(null), null);
});

test('an invalid period or a missing employee is rejected without echoing the value', () => {
  assert.throws(
    () => derive({ year: 1999 }),
    (error) => error.status === 400 && error.code === 'MONTHLY_INVALID_PERIOD',
  );
  assert.throws(
    () => derive({ month: 13 }),
    (error) => error.status === 400 && error.code === 'MONTHLY_INVALID_PERIOD',
  );
  assert.throws(
    () => derive({ month: 3.5 }),
    (error) => error.status === 400 && error.code === 'MONTHLY_INVALID_PERIOD',
  );
  assert.throws(
    () => calculateMonthlySummary({ year: 2026, month: 3, calendar: [] }),
    (error) => error.status === 400 && error.code === 'MONTHLY_INVALID_EMPLOYEE',
  );
  // An empty calendar is legal: it only means expected_working_days cannot be derived.
  assert.equal(derive({ calendar: [] }).expectedWorkingDays, null);
});

// --- counts and sums ---------------------------------------------------------

test('counts, sums and rule versions come from the daily rows', () => {
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02', status: 'late', lateMinutes: 15, earlyMinutes: 0, workDuration: 7.75 }),
      dailyRow({ date: '2026-03-03', status: 'present', workDuration: 8 }),
      dailyRow({ date: '2026-03-04', status: 'present', earlyMinutes: 30, workDuration: 7.5 }),
      dailyRow({ date: '2026-03-05', status: 'absent', computationStatus: 'no_data', workDuration: 0 }),
      dailyRow({ date: '2026-03-06', status: 'leave', workDuration: 0, ruleVersionCode: 'AR-0002' }),
      dailyRow({ date: '2026-03-07', status: 'holiday', dayClassification: 'weekend', workDuration: 0 }),
    ],
  });

  assert.equal(summary.employeeUid, EMP);
  assert.equal(summary.year, YEAR);
  assert.equal(summary.month, MONTH);
  assert.equal(summary.totalPresent, 2);
  assert.equal(summary.totalLate, 1);
  assert.equal(summary.totalAbsent, 1);
  assert.equal(summary.totalLeave, 1);
  assert.equal(summary.holidayDays, 1);
  assert.equal(summary.pendingDays, 0);
  assert.equal(summary.totalLateMinutes, 15);
  assert.equal(summary.totalEarlyMinutes, 30);
  assert.equal(summary.totalWorkHours, 23.25, '7.75 + 8 + 7.5');
  assert.equal(summary.totalWorkDays, 5, 'five rows were classified as workdays');
  assert.deepEqual(summary.ruleVersions, ['AR-0001', 'AR-0002'], 'both contributing rules, sorted');
  assert.equal(summary.sourceKind, 'derived_from_daily_attendance');
  assert.equal(summary.calculatedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(summary.dayCounts.rows, 6);
  assert.equal(summary.dayCounts.daysWithRows, 6);
});

test('rows for another employee or another month are excluded, not absorbed', () => {
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02' }),
      dailyRow({ date: '2026-03-02', employeeUid: OTHER }), // wrong employee
      dailyRow({ date: '2026-04-01' }), // wrong month
      dailyRow({ date: null }),
    ],
  });
  assert.equal(summary.dayCounts.rows, 1);
  assert.equal(summary.totalPresent, 1);
});

test('a non-numeric or missing minute value contributes zero rather than NaN', () => {
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02', lateMinutes: null, earlyMinutes: undefined, workDuration: 'nonsense' }),
    ],
  });
  assert.equal(summary.totalLateMinutes, 0);
  assert.equal(summary.totalEarlyMinutes, 0);
  assert.equal(summary.totalWorkHours, 0);
});

// --- the completeness verdict (the point of the module) ----------------------

test('no rows at all is no_data, never a month of zeros presented as complete', () => {
  const summary = derive({ dailyRows: [] });
  assert.equal(summary.computationStatus, 'no_data');
  assert.equal(summary.totalPresent, 0);
  assert.match(summary.derivationNotes, /no daily rows stored/);
});

test('one pending_policy day makes the whole month pending_policy', () => {
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02', status: 'present' }),
      dailyRow({ date: '2026-03-03', status: 'pending', computationStatus: 'pending_policy', ruleVersionCode: null }),
    ],
  });
  assert.equal(summary.computationStatus, 'pending_policy');
  assert.equal(summary.pendingDays, 1);
  assert.equal(summary.dayCounts.unjudgedDays, 1);
});

test('insufficient_data or failed days make the month partial', () => {
  for (const bad of ['insufficient_data', 'failed']) {
    const summary = derive({
      dailyRows: [
        dailyRow({ date: '2026-03-02' }),
        dailyRow({ date: '2026-03-03', status: 'pending', computationStatus: bad }),
      ],
    });
    assert.equal(summary.computationStatus, 'partial', `${bad} must be partial`);
    assert.equal(summary.dayCounts.unjudgedDays, 1);
  }
});

test('an absent day is a COMPLETE judgement, so it does not make the month partial', () => {
  // This is the subtle one: a working day with no scan is `no_data` at the DAY level, but the day was fully
  // judged (the rule said workday, nobody turned up). The month is therefore calculated, not partial.
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02', status: 'present' }),
      dailyRow({ date: '2026-03-03', status: 'absent', computationStatus: 'no_data' }),
    ],
  });
  assert.equal(summary.computationStatus, 'calculated');
  assert.equal(summary.dayCounts.unjudgedDays, 0);
  assert.equal(summary.totalAbsent, 1);
});

test('a month where every stored day was judged is calculated', () => {
  const summary = derive({
    dailyRows: [
      dailyRow({ date: '2026-03-02', status: 'late', lateMinutes: 5 }),
      dailyRow({ date: '2026-03-03', status: 'leave' }),
    ],
  });
  assert.equal(summary.computationStatus, 'calculated');
  assert.equal(summary.derivationNotes, null);
});

test('at least one unjudged day is required for a non-calculated verdict', () => {
  // No combination of judged rows may produce 'partial' or 'pending_policy'.
  const judgementStatuses = ['calculated', 'no_data'];
  for (const computation of judgementStatuses) {
    const summary = derive({ dailyRows: [dailyRow({ computationStatus: computation })] });
    assert.equal(summary.computationStatus, 'calculated');
  }
});

// --- expected working days ---------------------------------------------------

test('expected working days is the approved Mon-Fri calendar for the month', () => {
  const summary = derive({ calendar: calendarFor(YEAR, MONTH) });
  assert.equal(summary.expectedWorkingDays, 22, 'March 2026 has 22 weekdays');
});

test('an approved holiday is excluded from expected working days', () => {
  const summary = derive({ calendar: calendarFor(YEAR, MONTH, { holidayDates: ['2026-03-05'] }) });
  assert.equal(summary.expectedWorkingDays, 21);
});

test('a rule that does NOT ignore holidays counts them as working days', () => {
  const summary = derive({
    calendar: calendarFor(YEAR, MONTH, {
      rule: { workDays: WEEK, ignoreHolidays: false },
      holidayDates: ['2026-03-05'],
    }),
  });
  assert.equal(summary.expectedWorkingDays, 22, 'the rule explicitly says holidays are worked');
});

test('a custom working week is honoured', () => {
  // Mon-Sat: March 2026 has 22 weekdays + 4 Saturdays (7, 14, 21, 28) = 26.
  const summary = derive({
    calendar: calendarFor(YEAR, MONTH, { rule: { workDays: [1, 2, 3, 4, 5, 6], ignoreHolidays: true } }),
  });
  assert.equal(summary.expectedWorkingDays, 26);
});

test('expected working days is NULL, with a reason, when any day lacks an approved rule', () => {
  const calendar = calendarFor(YEAR, MONTH);
  calendar[10] = { date: calendar[10].date, rule: null, holiday: false };
  const summary = derive({ calendar });
  assert.equal(summary.expectedWorkingDays, null, 'null means "cannot be derived", never 0');
  assert.match(summary.derivationNotes, /no_approved_rule/);
});

test('expected working days is NULL when the approved rule omits the working week', () => {
  const summary = derive({
    calendar: calendarFor(YEAR, MONTH, { rule: { workDays: null, ignoreHolidays: true } }),
  });
  assert.equal(summary.expectedWorkingDays, null);
  assert.match(summary.derivationNotes, /working_week_not_specified/);
});

test('expected working days is NULL when no calendar is supplied at all', () => {
  const summary = derive({ calendar: [] });
  assert.equal(summary.expectedWorkingDays, null);
  assert.match(summary.derivationNotes, /calendar not supplied/);
});

test('missing working days are counted, and only when the calendar is derivable', () => {
  // March 2026 has 22 weekdays; supply rows for only two of them.
  const summary = derive({
    dailyRows: [dailyRow({ date: '2026-03-02' }), dailyRow({ date: '2026-03-03' })],
  });
  assert.equal(summary.dayCounts.missingWorkingDays, 20);
  assert.equal(summary.dayCounts.missingWorkingDayDates.includes('2026-03-04'), true);
  assert.equal(summary.dayCounts.missingWorkingDayDates.includes('2026-03-02'), false, 'a present day is not missing');
  assert.equal(summary.dayCounts.missingWorkingDayDates.includes('2026-03-07'), false, 'a Saturday is not expected');

  // With no derivable calendar the count is null rather than a wrong number.
  const notDerivable = derive({ calendar: [] });
  assert.equal(notDerivable.dayCounts.missingWorkingDays, null);
});

// --- determinism -------------------------------------------------------------

test('identical inputs produce byte-identical output (determinism)', () => {
  const input = {
    dailyRows: [dailyRow({ date: '2026-03-02', status: 'late', lateMinutes: 7 })],
    calendar: calendarFor(YEAR, MONTH, { holidayDates: ['2026-03-05'] }),
  };
  assert.deepEqual(derive(input), derive(input));
});

test('the module exposes its status vocabulary', () => {
  assert.deepEqual([...MONTH_COMPUTATION_STATUS], ['calculated', 'partial', 'pending_policy', 'no_data', 'failed']);
});
