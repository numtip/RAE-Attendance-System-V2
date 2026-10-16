/**
 * R-04 fiscal period (Oct-Sep, Buddhist Era). PURE domain — no database.
 *
 * The whole point of this suite is that the fiscal year is NOT the R-02 academic year and the two must
 * never be conflated. A test asserts they are different windows for the same span.
 */
process.env.JWT_SECRET = 'test-only-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FISCAL_YEAR_START_MONTH,
  fiscalYearPeriod,
  fiscalYearOf,
  fiscalYearLabelTh,
} = require('../src/domain/reconciliationPeriod');
const { academicYearPeriod, ACADEMIC_YEAR_START_MONTH } = require('../src/domain/attendanceReport');

test('the fiscal year is 1 October to 30 September, Buddhist Era', () => {
  const period = fiscalYearPeriod(2569);
  assert.equal(FISCAL_YEAR_START_MONTH, 10);
  assert.equal(period.from, '2025-10-01');
  assert.equal(period.to, '2026-09-30');
  assert.equal(period.gregorianFrom, '2025-10-01');
  assert.equal(period.gregorianTo, '2026-09-30');
  assert.equal(period.fiscalYear, 2569);
  assert.equal(period.fiscalYearStartMonth, 10);
  assert.equal(period.months.length, 12);
  assert.deepEqual(period.months[0], { year: 2025, month: 10 }, 'the year starts in October');
  assert.deepEqual(period.months[2], { year: 2025, month: 12 });
  assert.deepEqual(period.months[3], { year: 2026, month: 1 }, 'then January of the next CE year');
  assert.deepEqual(period.months[11], { year: 2026, month: 9 });
  assert.equal(period.labelTh, 'ปีงบประมาณ 2569');
  assert.equal(fiscalYearLabelTh(2569), 'ปีงบประมาณ 2569');
});

test('the fiscal boundary: 30 Sep is in, 1 Oct is the NEXT fiscal year', () => {
  assert.equal(fiscalYearOf('2025-09-30'), 2568);
  assert.equal(fiscalYearOf('2025-10-01'), 2569);
  assert.equal(fiscalYearOf('2026-09-30'), 2569);
  assert.equal(fiscalYearOf('2026-10-01'), 2570);
});

test('the fiscal 2569 window contains the fixture months 2026-03 and 2026-07', () => {
  const period = fiscalYearPeriod(2569);
  assert.ok(period.from <= '2026-03-01' && '2026-03-31' <= period.to);
  assert.ok(period.from <= '2026-07-01' && '2026-07-31' <= period.to);
});

test('the fiscal year and the academic year are DIFFERENT windows for the same span', () => {
  const fiscal = fiscalYearPeriod(2569); // 2025-10-01 .. 2026-09-30
  const academic = academicYearPeriod(2025); // 2025-06-01 .. 2026-05-31
  assert.equal(ACADEMIC_YEAR_START_MONTH, 6);
  assert.notEqual(fiscal.from, academic.from);
  assert.notEqual(fiscal.to, academic.to);
  assert.notDeepEqual(
    { from: fiscal.from, to: fiscal.to },
    { from: academic.from, to: academic.to },
  );
  // 2026-07 is inside the fiscal window but NOT inside that academic year (which ends 31 May 2026).
  assert.ok('2026-07-01' >= fiscal.from && '2026-07-01' <= fiscal.to);
  assert.ok('2026-07-01' > academic.to);
});

test('leap February 2028 sits inside the fiscal year that contains it', () => {
  assert.equal(fiscalYearOf('2028-02-29'), 2571); // 2027-10-01 .. 2028-09-30
  const period = fiscalYearPeriod(2571);
  assert.ok(period.from <= '2028-02-29' && '2028-02-29' <= period.to);
});

test('a bad fiscal year or bad date is rejected with RECONCILIATION_INVALID_PERIOD', () => {
  for (const bad of ['nope', 1.5, null, undefined, 1000, 99999]) {
    assert.throws(
      () => fiscalYearPeriod(bad),
      (error) => error.status === 400 && error.code === 'RECONCILIATION_INVALID_PERIOD',
      `fiscalYearPeriod(${String(bad)}) must be rejected`,
    );
  }
  for (const bad of ['2026-02-31', 'not-a-date', '2026-13-01', null, undefined]) {
    assert.throws(
      () => fiscalYearOf(bad),
      (error) => error.code === 'RECONCILIATION_INVALID_PERIOD',
    );
  }
  assert.throws(() => fiscalYearLabelTh('x'), (error) => error.code === 'RECONCILIATION_INVALID_PERIOD');
});
