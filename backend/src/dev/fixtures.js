const bcrypt = require('bcryptjs');

const passwordHash = bcrypt.hashSync('valid-pass', 8);

const employees = [
  {
    employeeUid: '11111111-1111-1111-1111-111111111111',
    employeeId: 'E-ADMIN',
    firstNameTh: 'แอดมิน',
    lastNameTh: 'ตัวอย่าง',
    email: 'admin@example.test',
    passwordHash,
    department: 'สำนักงาน',
    position: 'ผู้ดูแล',
    employeeType: 'university',
    status: 'active',
    role: 'admin',
    lockedUntil: null,
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    employeeId: 'E-USER',
    firstNameTh: 'ผู้ใช้',
    lastNameTh: 'ตัวอย่าง',
    email: 'user@example.test',
    passwordHash,
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    status: 'active',
    role: 'user',
    lockedUntil: null,
  },
  {
    employeeUid: '33333333-3333-3333-3333-333333333333',
    employeeId: 'E-LOCKED',
    firstNameTh: 'ล็อก',
    lastNameTh: 'ตัวอย่าง',
    email: 'locked@example.test',
    passwordHash,
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'contract',
    status: 'active',
    role: 'user',
    lockedUntil: '2099-01-01T00:00:00.000Z',
  },
];

const attendance = [
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    date: '2026-03-02',
    checkIn: '2026-03-02T01:35:00.000Z',
    checkOut: '2026-03-02T09:30:00.000Z',
    status: 'late',
    isLate: true,
    lateMinutes: 5,
    workDuration: 7.92,
  },
];

const monthly = [
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    year: 2026,
    month: 3,
    totalWorkDays: 22,
    totalPresent: 20,
    totalLate: 1,
    totalAbsent: 0,
    totalLeave: 1,
    totalLateMinutes: 5,
    totalWorkHours: 160,
  },
];

const employeeIdentifiers = [
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    idType: 'personnel_id',
    idValue: 'P-USER-001',
    sourceSystem: 'fixture',
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    idType: 'facescan_id',
    idValue: 'FS-USER-001',
    sourceSystem: 'fixture',
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    idType: 'national_id',
    idValue: '9900000000001',
    sourceSystem: 'fixture',
  },
];

const authorizationGrants = [];
const orgMemberships = [];

// Slice 1: effective-dated employment attributes. Synthetic only; this is the fixture twin of the
// employee_assignment table. One current (open-ended) row per fixture employee, plus one closed row so
// the effective-dated lookup is exercised in fixture/review mode.
const employeeAssignments = [
  {
    employeeUid: '11111111-1111-1111-1111-111111111111',
    employeeCode: 'E-ADMIN',
    department: 'สำนักงาน',
    position: 'ผู้ดูแล',
    employeeType: 'university',
    effectiveFrom: '2024-10-01',
    effectiveTo: null,
    sourceSystem: 'fixture',
    sourceReference: 'synthetic',
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    employeeCode: 'E-USER-A',
    department: 'งานบริการ',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    effectiveFrom: '2023-10-01',
    effectiveTo: '2025-09-30',
    sourceSystem: 'fixture',
    sourceReference: 'synthetic',
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    employeeCode: 'E-USER',
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    effectiveFrom: '2025-10-01',
    effectiveTo: null,
    sourceSystem: 'fixture',
    sourceReference: 'synthetic',
  },
];

const leave = [
  {
    leaveId: 'LV-1',
    employeeUid: '22222222-2222-2222-2222-222222222222',
    leaveType: 'personal',
    startDate: '2026-03-10',
    endDate: '2026-03-10',
    status: 'approved',
    matchStatus: 'matched',
  },
];

const balances = [
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    year: 2026,
    leaveType: 'personal',
    totalDays: 6,
    usedDays: 1,
    remainingDays: 5,
  },
];

module.exports = {
  employees,
  employeeIdentifiers,
  employeeAssignments,
  attendance,
  monthly,
  leave,
  balances,
  authorizationGrants,
  orgMemberships,
};
