const assert = require('node:assert/strict');
const test = require('node:test');

const { analyzeHipLeaveFile, classifyLeaveRow, HipLeaveFileError, leaveTypeOf } = require('../src/imports/hipLeaveRemarks');

const row = (over) => ({ line: 2, machineId: '1000', date: '2026-03-04', kind: 'วันทำงาน', checkIn: '', checkOut: '', remarks: [], ...over });
const verdict = (over) => classifyLeaveRow(row(over));

test('leave words map to the three types (variants with a note still classify)', () => {
  assert.equal(leaveTypeOf('กิจ'), 'personal');
  assert.equal(leaveTypeOf('ป่วย'), 'sick');
  assert.equal(leaveTypeOf('ป่วย (ผ่าตัดนิ้วเท้า)'), 'sick');
  assert.equal(leaveTypeOf('พักผ่อน'), 'vacation');
  assert.equal(leaveTypeOf('ไปราชการ'), null);
  assert.equal(leaveTypeOf('สงกรานต์1'), null);
});

test('owner example: 08:29 check-in only + กิจ,ไม่สแกนออก -> 0.5 personal PM', () => {
  assert.deepEqual(verdict({ checkIn: '08:29', remarks: ['กิจ', 'ไม่สแกนออก'] }),
    { leaveType: 'personal', dayPart: 'PM', dayFraction: 0.5, reviewStatus: 'candidate', reviewReason: null });
});

test('owner example: 16:45 check-out only + ป่วย,ไม่สแกนเข้า -> 0.5 sick AM', () => {
  assert.deepEqual(verdict({ checkOut: '16:45', remarks: ['ป่วย', 'ไม่สแกนเข้า'] }),
    { leaveType: 'sick', dayPart: 'AM', dayFraction: 0.5, reviewStatus: 'candidate', reviewReason: null });
});

test('owner example: 08:24 + ไม่สแกนออก without a leave word is a missing punch, NOT leave', () => {
  assert.equal(verdict({ checkIn: '08:24', remarks: ['ไม่สแกนออก'] }), null);
  assert.equal(verdict({ checkOut: '16:45', remarks: ['ไม่สแกนเข้า'] }), null);
  assert.equal(verdict({ checkIn: '08:30', checkOut: '16:30', remarks: ['สาย'] }), null);
});

test('leave remark and no scans -> full day 1.0', () => {
  assert.deepEqual(verdict({ remarks: ['พักผ่อน'] }),
    { leaveType: 'vacation', dayPart: 'FULL', dayFraction: 1, reviewStatus: 'candidate', reviewReason: null });
});

test('ambiguous or contradictory rows are needs_review, never a counted fraction', () => {
  const review = (over, reason) => {
    const v = verdict(over);
    assert.equal(v.reviewStatus, 'needs_review', JSON.stringify(over));
    assert.equal(v.dayFraction, null);
    assert.ok(v.reviewReason.split(',').includes(reason), `${reason} in ${v.reviewReason}`);
  };
  review({ checkIn: '08:30', checkOut: '16:30', remarks: ['กิจ'] }, 'both_scans_present');
  review({ checkIn: '08:30', remarks: ['กิจ', 'ไม่สแกนเข้า'] }, 'scan_contradicts_remark');
  review({ checkIn: '13:10', remarks: ['กิจ'] }, 'scan_time_implausible');
  review({ checkOut: '09:00', remarks: ['ป่วย'] }, 'scan_time_implausible');
  review({ kind: 'วันหยุด', remarks: ['ป่วย'] }, 'non_working_day');
  review({ kind: '', date: '2026-03-07', remarks: ['ป่วย'] }, 'non_working_day'); // Saturday, HIP gave no day kind
  review({ remarks: ['กิจ', 'ป่วย'] }, 'multiple_leave_types');
  review({ remarks: ['ป่วย', 'ขาดงาน'] }, 'conflicts_with_absent_flag');
  review({ remarks: ['ป่วย', 'ไปราชการ'] }, 'conflicts_with_official_duty');
});

const HEADER = 'รหัสที่เครื่อง,ชื่อพนักงาน,แผนก,วัน/เวลา ,สถานะ,เข้า [1],ออก [1],สาย [1],ออกก่อน [1],Remark [1],\n';

test('extra comma-separated remarks spill into following fields and are all read', () => {
  const text = `${HEADER}1000,ชื่อ,แผนก,4/3/2569,วันทำงาน,08:29,,,,กิจ,ไม่สแกนออก\n`
    + '1001,ชื่อ,แผนก,4/3/2569,วันทำงาน,,,,,,\n';
  const result = analyzeHipLeaveFile(text);
  assert.equal(result.period, '2026-03');
  assert.equal(result.stats.multiRemarkRows, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].dayPart, 'PM');
});

test('rows without scans are found, a duplicate person-day is deduplicated, a conflicting one is flagged', () => {
  const same = `${HEADER}1000,ช,แ,4/3/2569,วันทำงาน,,,,,พักผ่อน,\n1000,ช,แ,4/3/2569,วันทำงาน,,,,,พักผ่อน,\n`;
  assert.equal(analyzeHipLeaveFile(same).records.length, 1);
  const conflict = `${HEADER}1000,ช,แ,4/3/2569,วันทำงาน,,,,,พักผ่อน,\n1000,ช,แ,4/3/2569,วันทำงาน,08:30,,,,พักผ่อน,\n`;
  const [record] = analyzeHipLeaveFile(conflict).records;
  assert.equal(record.reviewStatus, 'needs_review');
  assert.match(record.reviewReason, /duplicate_source_conflict/);
});

test('a day almost everyone carries the same non-leave remark is a holiday; leave on it is flagged', () => {
  const people = Array.from({ length: 10 }, (_, i) => `${2000 + i},ช,แ,6/4/2569,วันทำงาน,,,,,จักรี,`).join('\n');
  const result = analyzeHipLeaveFile(`${HEADER}${people}\n3000,ช,แ,6/4/2569,วันทำงาน,,,,,กิจ,\n`);
  assert.equal(result.stats.holidayDates, 1);
  assert.match(result.records[0].reviewReason, /non_working_day/);
});

test('missing punches, official duty and HIP absent flags are counted but never become leave', () => {
  const text = `${HEADER}1,ช,แ,4/3/2569,วันทำงาน,08:00,,,,ไม่สแกนออก,\n2,ช,แ,4/3/2569,วันทำงาน,,,,,ขาดงาน,\n3,ช,แ,4/3/2569,วันทำงาน,,,,,ไปราชการ,\n`;
  const result = analyzeHipLeaveFile(text);
  assert.equal(result.records.length, 0);
  assert.deepEqual([result.stats.missingPunchOnly, result.stats.absentFlagged, result.stats.officialDuty], [1, 1, 1]);
});

test('a file that mixes months, or lacks the columns, is refused whole', () => {
  assert.throws(() => analyzeHipLeaveFile(`${HEADER}1,ช,แ,4/3/2569,วันทำงาน,,,,,,\n1,ช,แ,4/4/2569,วันทำงาน,,,,,,\n`), HipLeaveFileError);
  assert.throws(() => analyzeHipLeaveFile('a,b\n1,2\n'), HipLeaveFileError);
  assert.throws(() => analyzeHipLeaveFile(`${HEADER}1,ช,แ,31/2/2569,วันทำงาน,,,,,,\n`), HipLeaveFileError);
});
