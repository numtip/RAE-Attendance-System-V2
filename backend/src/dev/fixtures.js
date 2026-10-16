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

// ---------------------------------------------------------------------------
// Slice 2/3: versioned attendance rules, holiday calendar and schedules.
//
// AR-0001 carries the DRAFT candidate values from the donor project (08:30-16:30, late after 08:30,
// early before 16:30, working week Mon-Fri).
//
// OWNER DECISION 2026-10-16: the project owner APPROVED these values, so AR-0001 is `approved` and covers
// the 2026 calendar year. Its approved_to is deliberately set, with AR-0002 below as the unapproved
// successor, so the honesty gate stays demonstrable in the fixture: a 2026 date computes, and a 2027 date
// reports pending_policy because the only rule covering it is not approved.
//
// `approvedBy` is a SESSION LABEL, not a person. The database CHECK only requires it to be present; naming
// the accountable individual is required before any production use of these values.
// Everything here is synthetic.
// ---------------------------------------------------------------------------
const attendanceRuleVersions = [
  {
    ruleVersionCode: 'AR-0001',
    name: 'Default work hours (owner-approved 2026-10-16)',
    status: 'approved',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    workStart: '08:30:00',
    workEnd: '16:30:00',
    lateAfter: '08:30:00',
    earlyBefore: '16:30:00',
    overnightShift: false,
    maxShiftSpanMinutes: 960,
    ignoreHolidays: true,
    workDays: [1, 2, 3, 4, 5],
    leaveTypesJson: JSON.stringify(['sick', 'personal', 'vacation', 'other']),
    leaveAliasesJson: JSON.stringify({}),
    businessStatusesJson: JSON.stringify([]),
    sourceOfTruth: 'donor attendance-core config/settings.yaml, approved by the owner 2026-10-16',
    approvedBy: 'owner:session-2026-10-16',
    approvedAt: '2026-10-16T00:00:00.000Z',
    notes: 'Values approved by the project owner on 2026-10-16 (docs/memory/DECISIONS.md). approved_by is a session label, NOT a person: replace it with the accountable individual before production use.',
  },
  {
    ruleVersionCode: 'AR-0002',
    name: 'Proposed work hours for 2027 (NOT approved - demonstrates the policy gate)',
    status: 'pending_approval',
    effectiveFrom: '2027-01-01',
    effectiveTo: null,
    workStart: '08:30:00',
    workEnd: '16:30:00',
    lateAfter: '08:30:00',
    earlyBefore: '16:30:00',
    overnightShift: false,
    maxShiftSpanMinutes: 960,
    ignoreHolidays: true,
    workDays: [1, 2, 3, 4, 5],
    leaveTypesJson: JSON.stringify(['sick', 'personal', 'vacation', 'other']),
    leaveAliasesJson: JSON.stringify({}),
    businessStatusesJson: JSON.stringify([]),
    sourceOfTruth: 'proposal only - no owner sign-off',
    approvedBy: null,
    approvedAt: null,
    notes: 'Unapproved successor. A date in 2027 reports pending_policy because this is the only rule covering it.',
  },
];

const attendanceHolidays = [];

const attendanceSchedules = [];

// One stored daily_attendance row so the fixture/review mode shows a computed day with provenance.
const dailyAttendance = [];

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
  attendanceRuleVersions,
  attendanceHolidays,
  attendanceSchedules,
  dailyAttendance,
  attendance,
  monthly,
  leave,
  balances,
  authorizationGrants,
  orgMemberships,
};
