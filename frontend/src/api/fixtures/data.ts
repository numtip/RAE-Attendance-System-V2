import type {
  AttendanceRecord,
  EmployeePublic,
  LeaveBalanceRow,
  LeaveRow,
  MonthReportRow,
  MonthlySummary,
} from '../types';

/** Mirrors backend/src/dev/fixtures.js (no secrets). */
const employeesInternal = [
  {
    employeeUid: '11111111-1111-1111-1111-111111111111',
    employeeId: 'E-ADMIN',
    firstNameTh: 'แอดมิน',
    lastNameTh: 'ตัวอย่าง',
    email: 'admin@example.test',
    password: 'valid-pass',
    department: 'สำนักงาน',
    position: 'ผู้ดูแล',
    employeeType: 'university',
    status: 'active',
    role: 'admin',
    lockedUntil: null as string | null,
  },
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    employeeId: 'E-USER',
    firstNameTh: 'ผู้ใช้',
    lastNameTh: 'ตัวอย่าง',
    email: 'user@example.test',
    password: 'valid-pass',
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
    password: 'valid-pass',
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'contract',
    status: 'active',
    role: 'user',
    lockedUntil: '2099-01-01T00:00:00.000Z',
  },
];

export function publicEmployee(row: (typeof employeesInternal)[number]): EmployeePublic {
  return {
    employeeUid: row.employeeUid,
    employeeId: row.employeeId,
    firstNameTh: row.firstNameTh,
    lastNameTh: row.lastNameTh,
    email: row.email,
    department: row.department,
    position: row.position,
    employeeType: row.employeeType,
    status: row.status,
    role: row.role,
  };
}

export const fixtureEmployees = employeesInternal;

export const fixtureAttendance: AttendanceRecord[] = [
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

export const fixtureMonthly: MonthlySummary[] = [
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

/**
 * Review-mode only (R-02).
 *
 * A month whose stored completeness verdict is NOT `calculated`, so the static demo shows what an
 * incomplete month looks like instead of only the happy path. A month with no entry here is derived from
 * `fixtureMonthly` when present (`calculated`) and is otherwise reported as `not_derived`. The numbers
 * below are illustrative and are NOT real attendance.
 */
export const fixtureMonthReportOverrides: Record<
  string,
  { status: MonthReportRow['computationStatus']; reasons: string[]; month: MonthReportRow }
> = {
  '2026-7': {
    status: 'partial',
    reasons: ['month_partial', 'unjudged_days:2'],
    month: {
      year: 2026,
      month: 7,
      computationStatus: 'partial',
      isFinal: false,
      totalWorkDays: 23,
      totalPresent: 18,
      totalLate: 2,
      totalAbsent: 2,
      totalLeave: 1,
      totalLateMinutes: 12,
      totalEarlyMinutes: 0,
      totalWorkHours: 152,
      expectedWorkingDays: 23,
      pendingDays: 2,
      holidayDays: 0,
      ruleVersions: ['AR-0001'],
      dayCounts: { rows: 31, daysWithRows: 31, unjudgedDays: 2 },
      derivationNotes: 'synthetic review-mode example: two days could not be judged',
      calculatedAt: '2026-08-01T00:00:00.000Z',
      sourceKind: 'derived_from_daily_attendance',
    },
  },
};

export const fixtureLeave: LeaveRow[] = [
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

export const fixtureBalances: LeaveBalanceRow[] = [
  {
    employeeUid: '22222222-2222-2222-2222-222222222222',
    year: 2026,
    leaveType: 'personal',
    totalDays: 6,
    usedDays: 1,
    remainingDays: 5,
  },
];
