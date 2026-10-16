/**
 * R-04-C: the transcribed FY2569 aggregate evidence, checked for self-consistency and for PII safety.
 *
 * Two jobs, both deterministic and offline:
 *
 *  1. ARITHMETIC / PERIOD SELF-CONSISTENCY. The 12 monthly aggregates must sum to the transcribed totals,
 *     the discrepancy groups must sum to their total, and the fiscal months must line up with the real
 *     Oct-Sep window from `fiscalYearPeriod` (reused, never re-implemented here).
 *
 *  2. THE PII GUARD. The serialized fixture is scanned to prove it contains no national id, no email and no
 *     employee-code-then-name pattern. This repo is PUBLIC and the evidence came from a PRIVATE repo that
 *     holds real names, so this test is the reason a personal value cannot quietly be added to the fixture.
 *     The guard is proven non-vacuous by checking that each pattern DOES match a sample built in memory.
 *
 * It reads nothing from disk outside the fixture module and contacts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { fiscalYearPeriod } = require('../src/domain/reconciliationPeriod');
const {
  FISCAL_YEAR,
  monthlyAggregates,
  totals,
  discrepancyClassification,
  provenance,
} = require('./fixtures/fy2569Aggregates');

const COUNT_FIELDS = Object.freeze(['late', 'early', 'halfDayLeave', 'needsReview']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function sumOf(field) {
  return monthlyAggregates.reduce((total, record) => total + Number(record[field] || 0), 0);
}

test('the 12 monthly aggregates sum to the transcribed fiscal-year totals', () => {
  assert.equal(monthlyAggregates.length, 12);
  for (const field of COUNT_FIELDS) {
    assert.equal(sumOf(field), totals[field], `${field} must sum to the transcribed total`);
  }
  // Named explicitly so the numbers the owner approved are visible in the test, not only in the fixture.
  assert.equal(totals.late, 1600);
  assert.equal(totals.early, 24);
  assert.equal(totals.halfDayLeave, 11);
  assert.equal(totals.needsReview, 8);
});

test('the discrepancy groups sum to their total, and record the population as a count', () => {
  const { accepted, halfDayReclassified, singleScanAttributed, total, populationCodes } = discrepancyClassification;
  assert.equal(accepted + halfDayReclassified + singleScanAttributed, total);
  assert.equal(total, 26);
  assert.equal(accepted, 12);
  assert.equal(halfDayReclassified, 9);
  assert.equal(singleScanAttributed, 5);
  assert.equal(populationCodes, 53, 'the population is a count of codes, never a roster');
});

test('the fiscal months cover exactly Oct..Sep in order and line up with fiscalYearPeriod(2569)', () => {
  const period = fiscalYearPeriod(FISCAL_YEAR);
  assert.equal(period.from, '2025-10-01');
  assert.equal(period.to, '2026-09-30');
  assert.equal(period.gregorianFrom, '2025-10-01');
  assert.equal(period.gregorianTo, '2026-09-30');
  assert.equal(period.months.length, 12);

  // The window the helper produced, restated as month numbers, is Oct..Sep.
  assert.deepEqual(
    period.months.map((entry) => entry.month),
    [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'the fiscal year starts in October and ends in September',
  );

  const gregorianMonths = [];
  const fiscalMonths = [];
  monthlyAggregates.forEach((record, index) => {
    const expected = period.months[index];
    const expectedGregorian = `${expected.year}-${pad2(expected.month)}`;
    // Each calendar month's BE label is simply CE + 543, so Oct..Dec 2025 are 2568 and Jan..Sep 2026 are 2569.
    const expectedFiscal = `${expected.year + 543}-${pad2(expected.month)}`;

    assert.equal(record.monthIndex, index + 1, 'monthIndex is 1..12 in fiscal order');
    assert.equal(record.gregorianMonth, expectedGregorian, `month ${index + 1} Gregorian month`);
    assert.equal(record.fiscalMonth, expectedFiscal, `month ${index + 1} Buddhist-Era label`);

    // Every month is fully inside the fiscal window (first day >= from, last day <= to).
    const lastDay = new Date(Date.UTC(expected.year, expected.month, 0)).getUTCDate();
    assert.ok(record.gregorianMonth + '-01' >= period.from, `${record.gregorianMonth} starts inside the window`);
    assert.ok(`${record.gregorianMonth}-${pad2(lastDay)}` <= period.to, `${record.gregorianMonth} ends inside the window`);

    gregorianMonths.push(record.gregorianMonth);
    fiscalMonths.push(record.fiscalMonth);
  });

  // Exactly Oct..Sep, in order, with no gaps and no duplicates.
  assert.equal(gregorianMonths[0], '2025-10');
  assert.equal(gregorianMonths[11], '2026-09');
  assert.equal(new Set(gregorianMonths).size, 12, 'the 12 Gregorian months are distinct');
  assert.deepEqual([...gregorianMonths].sort(), gregorianMonths, 'the Gregorian months are strictly in order');

  // The BE labels begin at 2568-10 (Oct 2025) and end at 2569-09 (Sep 2026), as the donor labelled them.
  assert.equal(fiscalMonths[0], '2568-10');
  assert.equal(fiscalMonths[11], '2569-09');
  assert.equal(fiscalMonths[2], '2568-12', 'December is still in BE 2568');
  assert.equal(fiscalMonths[3], '2569-01', 'January rolls into BE 2569');
});

test('the provenance says plainly that this is transcription, not integration', () => {
  assert.match(provenance.source, /Attendance-Report/);
  assert.equal(provenance.file, 'CodexWorker/prepared/README.md');
  assert.equal(provenance.transcribedOn, '2026-10-16');
  assert.match(provenance.note, /TRANSCRIBED/);
  assert.match(provenance.note, /not a live integration/);
  assert.match(provenance.note, /does NOT verify/);
});

// ---------------------------------------------------------------------------
// the PII guard
// ---------------------------------------------------------------------------

/**
 * The three patterns that must never appear in a public-safe aggregate fixture:
 *   - a Thai 13-digit national id,
 *   - an email address,
 *   - a 4-digit employee code immediately followed by a Thai name (the shape that leaked in the private repo).
 */
const FORBIDDEN = Object.freeze({
  nationalId: /\b\d{13}\b/,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  codeThenThaiName: /\b\d{4}\s*[\u0E00-\u0E7F]/,
});

test('the fixture contains no national id, no email and no code-then-name pattern', () => {
  const serialized = JSON.stringify({
    FISCAL_YEAR, monthlyAggregates, totals, discrepancyClassification, provenance,
  });

  assert.equal(FORBIDDEN.nationalId.test(serialized), false, 'no 13-digit national id');
  assert.equal(FORBIDDEN.email.test(serialized), false, 'no email address');
  assert.equal(FORBIDDEN.codeThenThaiName.test(serialized), false, 'no 4-digit code followed by a Thai name');

  // The fixture is aggregate counts and short labels only: no Thai characters at all, so no name can hide.
  assert.equal(/[\u0E00-\u0E7F]/.test(serialized), false, 'the fixture carries no Thai text');
});

test('the PII guard is not vacuous: each pattern matches a value built only in memory', () => {
  // Samples are assembled at runtime so that this test file itself never contains a matching literal.
  const at = String.fromCharCode(64); // '@'
  const thaiName = String.fromCharCode(0x0E2A, 0x0E21); // two Thai letters, built at runtime only
  const fakeNationalId = ['9', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1'].join('');
  const fakeEmail = ['somebody', 'example', 'test'].join('.') + at + 'example.test';
  const fakeCodeThenName = ['1', '2', '3', '4'].join('') + ' ' + thaiName;

  assert.equal(FORBIDDEN.nationalId.test(fakeNationalId), true, 'the national-id pattern must catch a 13-digit id');
  assert.equal(FORBIDDEN.email.test(fakeEmail), true, 'the email pattern must catch an address');
  assert.equal(FORBIDDEN.codeThenThaiName.test(fakeCodeThenName), true, 'the code+name pattern must catch a match');
});
