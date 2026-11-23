const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const csv = require('../src/domain/hrLeaveCsv');

const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');
const TEMPLATES = path.join(backendRoot, '..', 'docs', 'hr-templates');
const TODAY = '2026-11-23';
const FY = 2570;

const P = csv.PROFILE_COLUMNS;
const E = csv.ENTITLEMENT_COLUMNS;
const table = (columns, rows) => ({ header: Object.values(columns), rows: rows.map((cells, i) => ({ line: i + 2, cells })) });
const profileRow = (over = {}) => {
  const base = { employeeId: '1001', name: 'x', type: '', hireDate: '2015-04-01', continuousServiceStart: '', appointmentKind: '', eligibilityConfirmed: '', eligibilityReference: '', sourceReference: 'doc 1', note: '', ...over };
  return Object.keys(P).map((k) => base[k]);
};
const entRow = (over = {}) => {
  const base = { employeeId: '1001', fiscalYearBe: '2570', leaveType: 'ลาพักผ่อน', entitlementDays: '10', carryoverDays: '', usageBaselineDays: '', usageBaselineThrough: '', sourceReference: 'doc 1', note: '', ...over };
  return Object.keys(E).map((k) => base[k]);
};
const codes = (r) => [...r.errors].sort();
const profile = (rows) => csv.validateProfile(table(P, rows), { today: TODAY });
const entitlement = (rows) => csv.validateEntitlement(table(E, rows), { currentFiscalYearBe: FY });

// ------------------------------------------------------------ text

test('the CSV parser handles BOM, CRLF, quotes, embedded commas and line breaks', () => {
  const parsed = csv.parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"line\nbreak",z\n');
  assert.deepEqual(parsed.header, ['a', 'b', 'c']);
  assert.deepEqual(parsed.rows.map((r) => r.cells), [['1', 'x, y', 'say "hi"'], ['2', 'line\nbreak', 'z']]);
  assert.deepEqual(parsed.rows.map((r) => r.line), [2, 4]);
});

test('an unterminated quote or an empty file is a file error', () => {
  assert.equal(csv.parseCsv('a,b\n1,"x').fileError, 'unterminated_quote');
  assert.equal(csv.parseCsv('').fileError, 'empty_file');
  assert.equal(csv.parseCsv('\r\n\r\n').fileError, 'empty_file');
});

test('the shipped templates are exactly the headers the validator expects', () => {
  for (const [file, columns] of [['hr_leave_profile_template.csv', P], ['hr_leave_entitlement_template.csv', E]]) {
    const parsed = csv.parseCsv(fs.readFileSync(path.join(TEMPLATES, file), 'utf8'));
    assert.deepEqual(parsed.header, Object.values(columns), file);
    assert.deepEqual(parsed.rows, []);
    assert.deepEqual(csv.checkHeader(parsed.header, columns), []);
  }
});

test('the header must match the template: missing, unknown and duplicate columns are refused, order is free', () => {
  const names = Object.values(P);
  assert.deepEqual(csv.checkHeader([...names].reverse(), P), []);
  assert.deepEqual(csv.checkHeader(names.slice(1), P), ['missing_column']);
  assert.deepEqual(csv.checkHeader([...names, 'extra'], P), ['unknown_column']);
  assert.deepEqual(csv.checkHeader([...names, names[0]], P), ['duplicate_column']);
  assert.deepEqual(profile([]).fileErrors, []);
  assert.deepEqual(csv.validateProfile({ header: names.slice(1), rows: [] }, { today: TODAY }).fileErrors, ['missing_column']);
});

// ------------------------------------------------------------ field parsers

test('dates: Gregorian ISO or Buddhist DD/MM/YYYY; anything ambiguous or impossible is refused', () => {
  assert.equal(csv.parseHrDate('2015-04-01'), '2015-04-01');
  assert.equal(csv.parseHrDate('1/4/2558'), '2015-04-01');
  assert.equal(csv.parseHrDate('01/04/2558'), '2015-04-01');
  for (const bad of ['01/04/2015', '01/04/15', '2015-02-30', '2015-4-1', '', 'x', '31/02/2558', '2015-04-01 ', '1900-01-01', '2200-01-01']) {
    assert.equal(csv.parseHrDate(bad === '2015-04-01 ' ? 'x' : bad), null, bad);
  }
  assert.equal(csv.parseHrDate(' 2015-04-01 '), '2015-04-01'); // surrounding spaces are trimmed
});

test('days: plain numbers in steps of 0.5 within range', () => {
  assert.equal(csv.parseDays('10', 120), 10);
  assert.equal(csv.parseDays('10.5', 120), 10.5);
  assert.equal(csv.parseDays('0', 30), 0);
  for (const bad of ['10.3', '-1', '1e2', '', '31', '1,5', 'สิบ', '10.25']) assert.equal(csv.parseDays(bad, 30), null, bad);
});

// ------------------------------------------------------------ profile rules

test('a clean profile row has no findings and carries only what was filled in', () => {
  const { rows } = profile([profileRow({ continuousServiceStart: '2015-04-01', appointmentKind: 'อื่น ๆ (เปลี่ยนสถานภาพ/จ้างต่อเนื่อง)' })]);
  assert.deepEqual([rows[0].errors, rows[0].warnings], [[], []]);
  assert.deepEqual(rows[0].data, { employeeId: '1001', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', appointmentKind: 'other', sourceReference: 'doc 1' });
});

test('profile ids: exactly four digits, no spreadsheet artefacts, no duplicates', () => {
  const { rows } = profile([profileRow({ employeeId: '1234.0' }), profileRow({ employeeId: '123' }), profileRow({ employeeId: '12345' }), profileRow({ employeeId: '1.2E3' }),
    profileRow({ employeeId: '2001' }), profileRow({ employeeId: '2001' })]);
  assert.deepEqual(rows.map(codes), [['id_format'], ['id_format'], ['id_format'], ['id_format'], [], ['id_duplicate']]);
});

test('profile dates: format, future hire, continuity after hire; a missing hire date is only a warning', () => {
  const { rows } = profile([
    profileRow({ hireDate: '2015-02-30' }),
    profileRow({ employeeId: '1002', hireDate: '2030-01-01', appointmentKind: 'บรรจุครั้งแรก' }),
    profileRow({ employeeId: '1003', continuousServiceStart: '2016-01-01' }),
    profileRow({ employeeId: '1004', hireDate: '', continuousServiceStart: '2010-01-01' }),
    profileRow({ employeeId: '1005', hireDate: '01/04/2558' }),
  ]);
  assert.deepEqual(rows.map(codes), [['date_format'], ['hire_in_future'], ['continuity_after_hire'], [], []]);
  assert.deepEqual(rows[3].warnings, ['hire_missing']);
  assert.equal(rows[4].data.hireDate, '2015-04-01');
});

test('appointment kind: a known value; a hire date from 2025-10-01 marks it as required for university staff (the importer decides by policy)', () => {
  const { rows } = profile([
    profileRow({ appointmentKind: 'บรรจุครั้งแรก', hireDate: '2026-02-01' }),
    profileRow({ employeeId: '1002', appointmentKind: 'อะไรสักอย่าง' }),
    profileRow({ employeeId: '1003', hireDate: '2026-02-01' }),
    profileRow({ employeeId: '1004', hireDate: '2025-09-30' }),
  ]);
  assert.deepEqual(rows.map(codes), [[], ['appointment_kind_unknown'], [], []]);
  assert.deepEqual(rows.map((r) => Boolean(r.appointmentKindRequiredForUniversity)), [false, false, true, false]);
  assert.equal(rows[0].data.appointmentKind, 'first');
});

test('an eligibility decision needs its document reference, and a reference needs a decision', () => {
  const { rows } = profile([
    profileRow({ eligibilityConfirmed: 'ใช่', eligibilityReference: 'memo 3/2569' }),
    profileRow({ employeeId: '1002', eligibilityConfirmed: 'ไม่ใช่', eligibilityReference: 'memo 4' }),
    profileRow({ employeeId: '1003', eligibilityConfirmed: 'ใช่' }),
    profileRow({ employeeId: '1004', eligibilityReference: 'memo 5' }),
    profileRow({ employeeId: '1005', eligibilityConfirmed: 'อาจจะ', eligibilityReference: 'memo 6' }),
  ]);
  assert.deepEqual(rows.map(codes), [[], [], ['confirmation_needs_reference'], ['confirmation_needs_reference'], ['confirmation_value']]);
  assert.deepEqual([rows[0].data.eligibilityConfirmed, rows[1].data.eligibilityConfirmed], [true, false]);
});

test('a row with data needs a source; an all-blank row is a warning; long notes are refused; wrong width is refused', () => {
  const { rows } = profile([
    profileRow({ sourceReference: '' }),
    profileRow({ employeeId: '1002', hireDate: '', sourceReference: '' }),
    profileRow({ employeeId: '1003', note: 'x'.repeat(201) }),
    ['1004', 'x'],
  ]);
  assert.deepEqual(rows.map(codes), [['source_missing'], [], ['note_too_long'], ['row_columns']]);
  assert.deepEqual(rows[1].warnings.sort(), ['hire_missing', 'no_data']);
});

test('a blank cell leaves a stored value alone and "-" clears it', () => {
  const { rows } = profile([profileRow({ hireDate: '', continuousServiceStart: '-', appointmentKind: '-', eligibilityConfirmed: '-' })]);
  assert.deepEqual(rows[0].errors, []);
  assert.equal('hireDate' in rows[0].data, false); // blank: not touched
  assert.deepEqual([rows[0].data.continuousServiceStart, rows[0].data.appointmentKind, rows[0].data.eligibilityConfirmed, rows[0].data.eligibilityReference], [null, null, null, null]);
});

test('too many rows is a file error', () => {
  const many = Array.from({ length: 1001 }, (_, i) => profileRow({ employeeId: String(1000 + (i % 9000)) }));
  assert.deepEqual(profile(many).fileErrors, ['too_many_rows']);
});

// ------------------------------------------------------------ entitlement rules

test('a clean entitlement row carries its numbers', () => {
  const { rows } = entitlement([entRow({ carryoverDays: '4.5', usageBaselineDays: '2', usageBaselineThrough: '2026-11-15' })]);
  assert.deepEqual(rows[0].errors, []);
  assert.deepEqual(rows[0].data, {
    employeeId: '1001', fiscalYearBe: 2570, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 4.5, usageBaselineDays: 2, usageBaselineThrough: '2026-11-15', sourceReference: 'doc 1',
  });
});

test('fiscal year and leave type: 2569 .. current+1 and the three Thai names', () => {
  const { rows } = entitlement([
    entRow({ fiscalYearBe: '2568' }), entRow({ employeeId: '1002', fiscalYearBe: '2572' }), entRow({ employeeId: '1003', fiscalYearBe: '2571' }),
    entRow({ employeeId: '1004', fiscalYearBe: '2026' }), entRow({ employeeId: '1005', leaveType: 'ลาคลอด' }),
  ]);
  assert.deepEqual(rows.map(codes), [['fiscal_year_range'], ['fiscal_year_range'], [], ['fiscal_year_range'], ['leave_type_unknown']]);
});

test('entitlement days and carry-over: steps of 0.5, ranges, vacation only', () => {
  const { rows } = entitlement([
    entRow({ entitlementDays: '10.3' }), entRow({ employeeId: '1002', entitlementDays: '121' }),
    entRow({ employeeId: '1003', leaveType: 'ลาป่วย', entitlementDays: '60', carryoverDays: '3' }),
    entRow({ employeeId: '1004', carryoverDays: '31' }), entRow({ employeeId: '1005', carryoverDays: '0' }),
  ]);
  assert.deepEqual(rows.map(codes), [['days_format'], ['days_format'], ['carryover_not_vacation'], ['days_format'], []]);
  assert.equal(rows[4].data.carryoverDays, 0); // 0 is HR's statement that nothing is carried over, not "unknown"
});

test('a usage baseline needs both parts and a date inside the fiscal year', () => {
  const { rows } = entitlement([
    entRow({ usageBaselineDays: '2' }), entRow({ employeeId: '1002', usageBaselineThrough: '2026-11-15' }),
    entRow({ employeeId: '1003', usageBaselineDays: '2', usageBaselineThrough: '2026-09-30' }),
    entRow({ employeeId: '1004', usageBaselineDays: '2', usageBaselineThrough: '15/11/2569' }),
    entRow({ employeeId: '1005', usageBaselineDays: 'x', usageBaselineThrough: '2026-11-15' }),
    entRow({ employeeId: '1006', usageBaselineDays: '2', usageBaselineThrough: '2026-13-01' }),
    entRow({ employeeId: '1007', usageBaselineDays: '-', usageBaselineThrough: '-' }),
    entRow({ employeeId: '1008', usageBaselineDays: '-' }),
  ]);
  assert.deepEqual(rows.map(codes), [['baseline_pair'], ['baseline_pair'], ['baseline_pair'], [], ['days_format'], ['date_format'], [], ['baseline_pair']]);
  assert.equal(rows[3].data.usageBaselineThrough, '2026-11-15');
  assert.deepEqual([rows[6].data.usageBaselineDays, rows[6].data.usageBaselineThrough], [null, null]);
});

test('entitlement source, duplicates and notes', () => {
  const { rows } = entitlement([
    entRow({ sourceReference: '' }), entRow({ employeeId: '1002' }), entRow({ employeeId: '1002' }), entRow({ employeeId: '1002', leaveType: 'ลาป่วย', entitlementDays: '60' }),
    entRow({ employeeId: '1003', note: 'x'.repeat(201) }),
  ]);
  assert.deepEqual(rows.map(codes), [['source_missing'], [], ['id_duplicate'], [], ['note_too_long']]);
});
