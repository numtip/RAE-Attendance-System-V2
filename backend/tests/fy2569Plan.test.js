const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFy2569Plan } = require('../src/imports/fy2569Plan');

const people = [
  { code: '9001', name: 'ทดสอบ หนึ่ง', department: 'หน่วย' },
  { code: '9002', name: 'ทดสอบ สอง', department: 'หน่วย' },
  { code: '9002', name: 'คนอื่น สอง', department: 'หน่วย' },
];

test('fy2569 plan keeps verified facts and records gaps without filling days', () => {
  const plan = buildFy2569Plan({
    people,
    events: [
      { employeeId: '9001', employeeName: 'ทดสอบ หนึ่ง', date: '2025-10-06', eventType: 'มาสาย', actualTime: '08:47:00', deviation: '00:17:00' },
      { employeeId: '9001', employeeName: 'ทดสอบ หนึ่ง', date: '2025-10-06', eventType: 'กลับก่อน', actualTime: '16:10:00', deviation: '00:20:00' },
      { employeeId: '9001', employeeName: 'ชื่อ ไม่ตรง', date: '2025-11-01', eventType: 'มาสาย', actualTime: '08:40:00', deviation: '00:10:00' },
      { employeeId: '9099', employeeName: 'ไม่มี ในบัญชี', date: '2025-11-02', eventType: 'มาสาย', actualTime: '08:40:00', deviation: '00:10:00' },
      { employeeId: '9001', employeeName: 'ทดสอบ หนึ่ง', date: '2024-01-01', eventType: 'มาสาย', actualTime: '08:40:00', deviation: '00:10:00' },
      { employeeId: '9002', employeeName: 'ทดสอบ สอง', date: '2025-12-01', eventType: 'มาสาย', actualTime: '08:40:00', deviation: '00:10:00' },
    ],
    leave: [
      { employeeId: '9001', employeeName: 'ทดสอบ หนึ่ง', date: '2026-03-10', leaveType: 'ลากิจ' },
      { employeeId: '9001', employeeName: 'ทดสอบ หนึ่ง', date: '2026-03-11', leaveType: 'ไม่ทราบ' },
    ],
    review: [
      { employeeId: '1013' },
      { employeeId: '3015' },
    ],
    summary: [
      { year: 2026, month: 3, employeeId: '1020', lateCount: 1, earlyCount: 0, reportLate: 2, reportEarly: 0 },
      { year: 2026, month: 4, employeeId: '9001', lateCount: 1, earlyCount: 0, reportLate: 1, reportEarly: 0 },
      { year: 2025, month: 10, employeeId: '9001', lateCount: 1, earlyCount: 0, reportLate: 1, reportEarly: 0 },
    ],
  });

  assert.equal(plan.late, 1);
  assert.equal(plan.early, 1);
  assert.equal(plan.leave, 1);
  assert.equal(plan.attendanceDays, 1);
  assert.equal(plan.attendance[0].status, 'late');
  assert.equal(plan.attendance[0].lateMinutes, 17);
  assert.ok(plan.attendance[0].checkIn);
  assert.ok(plan.attendance[0].checkOut);
  assert.equal(plan.blockedEmployees, 1);
  assert.equal(plan.gaps.nameConflicts, 1);
  assert.deepEqual(plan.gaps.unmatchedCodes, ['9002', '9099']);
  assert.equal(plan.gaps.outsidePeriod, 1);
  assert.equal(plan.gaps.withheldReview, 2);
  assert.equal(plan.gaps.codeGaps['1013'].review, 1);
  assert.equal(plan.gaps.codeGaps['3015'].review, 1);
  assert.equal(plan.gaps.mismatchPersonMonths, 1);
  assert.equal(plan.gaps.marchMismatchPersonMonths, 1);
  assert.equal(plan.gaps.codeGaps['1020'].mismatchMonths, 1);
  assert.equal(plan.gaps.unknownLeaveType, 1);
  assert.ok(plan.gaps.missingMonths.length > 0);
});
