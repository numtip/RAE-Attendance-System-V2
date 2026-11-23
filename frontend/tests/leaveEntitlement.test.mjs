import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FISCAL_YEAR_BE, fiscalRangeTh, fiscalYearOptions, formatDays, isMeterValid, reasonsTh, statusLabelTh,
  uncoveredMonthsTh, usedDaysDisplay, usedPercent,
} from '../src/utils/leaveEntitlement.ts';

const ok = {
  employeeUid: 'u', year: 2570, leaveType: 'vacation', status: 'ok', available: true, usageComplete: true,
  totalDays: 15, usedDays: 4, remainingDays: 11, entitlementDays: 10, carryoverDays: 5,
};

test('default fiscal year is FY2570 and the options respect the engine minimum', () => {
  assert.equal(DEFAULT_FISCAL_YEAR_BE, 2570);
  const options = fiscalYearOptions();
  assert.ok(options.includes(2570));
  assert.ok(Math.min(...options) >= 2569);
});

test('a complete, determined row gets a progress bar', () => {
  assert.equal(isMeterValid(ok), true);
  assert.equal(usedPercent(ok), 27);
});

test('no bar when any input is undetermined (never a 0% bar)', () => {
  for (const patch of [
    { status: 'needs_hr' }, { available: false }, { usageComplete: false }, { totalDays: null }, { totalDays: 0 },
    { usedDays: null }, { remainingDays: null },
  ]) {
    const row = { ...ok, ...patch };
    assert.equal(isMeterValid(row), false, JSON.stringify(patch));
    assert.equal(usedPercent(row), null, JSON.stringify(patch));
  }
});

test('legacy calendar rows (no status field) still get a bar when available', () => {
  const { status, usageComplete, ...legacy } = ok;
  assert.equal(isMeterValid(legacy), true);
});

test('over-allowance clamps to 100%', () => {
  assert.equal(usedPercent({ ...ok, totalDays: 10, usedDays: 12, remainingDays: 0 }), 100);
});

test('unknown is shown as a dash, zero as 0, halves with one decimal', () => {
  assert.equal(formatDays(null), '—');
  assert.equal(formatDays(undefined), '—');
  assert.equal(formatDays(0), '0');
  assert.equal(formatDays(2.5), '2.5');
  assert.equal(formatDays(10), '10');
});

test('Thai status labels cover every engine status, unknown values fall back safely', () => {
  for (const s of ['ok', 'needs_hr', 'pending_hr_decision', 'pending_policy', 'unknown', 'out_of_scope', 'not_started']) {
    assert.match(statusLabelTh(s), /[฀-๿]/);
  }
  assert.equal(statusLabelTh(undefined), 'ไม่มีข้อมูล');
  assert.equal(statusLabelTh('something_new'), 'ไม่มีข้อมูล');
});

test('fiscal range and uncovered months are shown in พ.ศ.', () => {
  assert.equal(fiscalRangeTh({ fiscalYear: { be: 2570, start: '2026-10-01', end: '2027-09-30' } }), '1/10/2569 – 30/9/2570');
  assert.equal(fiscalRangeTh({}), null);
  assert.equal(uncoveredMonthsTh({ ...ok, uncoveredMonths: ['2026-12', '2027-01'] }), '12/2569, 1/2570');
  assert.equal(uncoveredMonthsTh({ ...ok, uncoveredMonths: [] }), null);
});

test('incomplete usage explains itself in Thai', () => {
  assert.equal(reasonsTh({ ...ok, reasons: ['usage_coverage_incomplete', 'unmapped'] }).length, 1);
});

test('used days are unknown while usage coverage is incomplete (never a partial or zero figure)', () => {
  assert.equal(usedDaysDisplay(ok), 4);
  assert.equal(usedDaysDisplay({ ...ok, usedDays: 0 }), 0);
  assert.equal(usedDaysDisplay({ ...ok, usageComplete: false, usedDays: 0 }), null);
  assert.equal(usedDaysDisplay({ ...ok, usedDays: null }), null);
});
