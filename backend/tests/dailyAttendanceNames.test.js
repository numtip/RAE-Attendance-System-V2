const assert = require('node:assert/strict');
const test = require('node:test');

const { createAttendanceService } = require('../src/services/attendanceService');
const { ORGANIZATION_NAME_TH } = require('../src/config/organization');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

function repos(grants, unitMembers) {
  return {
    authorization: {
      async grantsFor() { return grants; },
      async uidsInOrgUnits() { return unitMembers; },
    },
    employees: {
      async list() {
        return [
          { employeeUid: A, employeeId: '1001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', status: 'active' },
          { employeeUid: B, employeeId: '1002', firstNameTh: 'สมหญิง', lastNameTh: 'รักงาน', status: 'active' },
        ];
      },
    },
    attendance: {
      async findDaily() {
        return [
          { employeeUid: A, date: '2026-03-02', status: 'present' },
          { employeeUid: B, date: '2026-03-02', status: 'late' },
          { employeeUid: 'cccccccc-0000-0000-0000-000000000003', date: '2026-03-02', status: 'present' },
        ];
      },
    },
  };
}

test('organization name is the owner-approved one', () => {
  assert.equal(ORGANIZATION_NAME_TH, 'สำนักวิจัยและส่งเสริมวิชาการการเกษตร');
});

test('executive daily rows carry Thai name and employee id; unmatched uid stays null', async () => {
  const service = createAttendanceService({
    repositories: repos([{ employeeUid: 'x', role: 'EXECUTIVE', scopeType: 'organization' }], []),
  });
  const rows = await service.daily({ role: 'executive', employeeUid: 'x' }, '2026-03-02');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].employeeName, rows[0].employeeId], ['สมชาย ใจดี', '1001']);
  assert.equal(rows[2].employeeName, null);
  assert.equal(rows[2].employeeId, null);
});

test('manager daily rows are limited to the granted unit and never name out-of-scope staff', async () => {
  const service = createAttendanceService({
    repositories: repos([{ employeeUid: 'm', role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }], [A]),
  });
  const rows = await service.daily({ role: 'manager', employeeUid: 'm' }, '2026-03-02');
  assert.deepEqual(rows.map((row) => row.employeeUid), [A]);
  assert.ok(!JSON.stringify(rows).includes('สมหญิง'));
});

test('own daily rows carry the caller identity only', async () => {
  const service = createAttendanceService({ repositories: repos([], []) });
  const rows = await service.meDaily({ role: 'employee', employeeUid: B }, '2026-03-02');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeName, 'สมหญิง รักงาน');
});
