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

// ------------------------------------------------------------ organisation overview helpers

import { cellView, filterRows, missingLabelTh, parseDaysInput, scopeLabelTh } from '../src/utils/leaveEntitlement.ts';

const cell = (extra = {}) => ({ status: 'ok', source: 'computed', available: true, entitlementDays: 10, carryoverDays: 0, totalDays: 10, usedDays: 4, pendingDays: 0, remainingDays: 6, usageComplete: true, missing: [], reasons: [], flags: [], ...extra });
const person = (extra = {}) => ({ employeeUid: 'u', employeeId: 'E001', name: 'สมชาย ใจดี', employeeType: 'university', division: { code: 'D1', nameTh: 'กอง 1' }, scope: 'in_policy', missing: [], types: {}, ...extra });

test('a determined cell shows the number and a bar; anything else shows no number and no bar', () => {
  assert.deepEqual(cellView(cell()), { text: '6', sub: 'จาก 10', tone: 'ok', meter: 40 });
  for (const patch of [{ status: 'unknown', available: false, remainingDays: null }, { usageComplete: false, available: false, remainingDays: null }, { status: 'needs_hr', available: false, remainingDays: null }]) {
    const v = cellView(cell(patch));
    assert.equal(v.text, 'ไม่มีข้อมูล');
    assert.equal(v.meter, null);
  }
  assert.equal(cellView(cell({ usageComplete: false, available: false, remainingDays: null })).sub, 'ข้อมูลการลาไม่ครบทุกเดือน');
  assert.equal(cellView(cell({ status: 'out_of_scope', available: false, remainingDays: null })).text, '—');
  assert.equal(cellView(undefined).text, '—');
  assert.equal(cellView(cell({ remainingDays: 0, usedDays: 10 })).text, '0'); // a real zero stays a zero
});

test('Thai labels for scope and missing facts, with a neutral fallback', () => {
  assert.equal(scopeLabelTh('excluded'), 'อยู่นอกประกาศ');
  assert.equal(missingLabelTh('hireDate'), 'วันที่เริ่มจ้าง');
  assert.equal(missingLabelTh('something_new'), 'ข้อมูลที่ยังไม่ครบ');
});

test('filters: name/id search, scope, division, and "needs attention" ignores excluded people', () => {
  const rows = [
    person(), person({ employeeUid: 'b', employeeId: 'E002', name: 'สมหญิง', scope: 'unconfirmed', missing: ['hireDate'] }),
    person({ employeeUid: 'c', employeeId: 'E003', name: 'จ้างเหมา', scope: 'excluded', missing: ['hireDate'], division: { code: 'D2', nameTh: 'กอง 2' } }),
  ];
  const all = { query: '', scope: '', division: '', missingOnly: false };
  assert.equal(filterRows(rows, all).length, 3);
  assert.deepEqual(filterRows(rows, { ...all, query: 'e002' }).map((r) => r.employeeUid), ['b']);
  assert.deepEqual(filterRows(rows, { ...all, query: 'สมชาย' }).map((r) => r.employeeUid), ['u']);
  assert.deepEqual(filterRows(rows, { ...all, scope: 'excluded' }).map((r) => r.employeeUid), ['c']);
  assert.deepEqual(filterRows(rows, { ...all, division: 'D2' }).map((r) => r.employeeUid), ['c']);
  assert.deepEqual(filterRows(rows, { ...all, missingOnly: true }).map((r) => r.employeeUid), ['b']);
});

test('day input: blank is "not entered", halves are fine, everything else is invalid', () => {
  assert.equal(parseDaysInput('', 30), null);
  assert.equal(parseDaysInput(' 7.5 ', 30), 7.5);
  assert.equal(parseDaysInput('0', 30), 0);
  for (const bad of ['7.3', '-1', '31', 'abc', '1,5', '1e1']) assert.equal(parseDaysInput(bad, 30), 'invalid', bad);
});
