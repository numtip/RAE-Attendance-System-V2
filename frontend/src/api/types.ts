export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  message?: string;
}

export interface EmployeePublic {
  employeeUid: string;
  employeeId: string;
  firstNameTh: string;
  lastNameTh: string;
  email: string;
  department: string;
  position: string;
  employeeType: string;
  status: string;
  role: string;
}

export interface LoginEmployee {
  employeeUid: string;
  email: string;
  role: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  employee: LoginEmployee;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export interface AttendanceRecord {
  employeeUid: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
  isLate?: boolean;
  lateMinutes?: number;
  workDuration?: number;
  /** Resolved server-side for in-scope rows; null when no employee record matches. */
  employeeId?: string | null;
  employeeName?: string | null;
}

export interface MonthlySummary {
  employeeUid: string;
  year: number;
  month: number;
  totalWorkDays: number;
  totalPresent: number;
  totalLate: number;
  totalAbsent: number;
  totalLeave: number;
  totalLateMinutes: number;
  totalWorkHours: number;
}

export interface LeaveRow {
  leaveId: string;
  employeeUid: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  status: string;
  matchStatus?: string;
}

export interface PersonalScan {
  date: string;
  dateLabel: string;
  checkInLabel: string;
  checkOutLabel: string;
  statusLabel: string;
  lateMinutes: number | null;
}

export interface PersonalLeaveRow {
  typeLabel: string;
  startLabel: string;
  endLabel: string;
  statusLabel: string;
}

export interface PersonalReport {
  employeeUid: string;
  employeeId: string;
  employeeName: string;
  department: string;
  position: string;
  year: number;
  month: number;
  buddhistYear: number;
  periodLabel: string;
  empty: boolean;
  hasMonthlySummary: boolean;
  present: number | null;
  late: number | null;
  absent: number | null;
  leaveDaysOnSummary: number | null;
  workDays: number | null;
  lateMinutes: number | null;
  scans: PersonalScan[];
  leaveRows: PersonalLeaveRow[];
  remainingLeaveDays: number | null;
  source: string;
  notices: {
    holidaysApplied: boolean;
    holidayNote: string;
  };
}

export interface DivisionBucket {
  headcount: number;
  withData: number;
  withoutData: number;
  present: number;
  late: number;
  lateMinutes: number;
  leaveDaysOnSummary: number;
  avgPresentPerPerson: number | null;
}
export interface DivisionSummary extends DivisionBucket {
  code: string;
  nameTh: string;
  rows: OrganizationReportRow[];
}
export interface DivisionReport {
  scope: 'organization' | 'team';
  year: number;
  month: number;
  buddhistYear: number;
  periodLabel: string;
  totals: OrganizationReport['totals'];
  divisions: DivisionSummary[];
  unassigned: DivisionBucket & { rows: OrganizationReportRow[] };
  ambiguous: DivisionBucket & { rows: OrganizationReportRow[] };
  reconciliation: { employeesInScope: number; assignedToDivisions: number; unassigned: number; ambiguous: number; reconciled: boolean };
  notices: { holidayNote: string; membershipNote: string };
}

export type LeaveKind = 'personal' | 'sick' | 'vacation';
export interface LeaveBucket { requests: number; days: number }
export interface LeaveMonthlyDetail {
  leaveType: string;
  typeLabel: string;
  startLabel: string;
  endLabel: string;
  status: string;
  statusLabel: string;
  daysInMonth: number;
  crossesMonth: boolean;
  counted: boolean;
}
export interface RecordedBucket { days: number; records: number; fullDays: number; halfDays: number }
export interface RecordedDetail {
  date: string;
  dateLabel: string;
  leaveType: string;
  typeLabel: string;
  dayPart: 'FULL' | 'AM' | 'PM' | 'UNKNOWN';
  partLabel: string;
  dayFraction: number | null;
  reviewStatus: 'candidate' | 'needs_review';
  reasonLabels: string[];
  approvalStatus: string;
}
export interface LeaveMonthlyRow {
  /** HIP-recorded leave (not approval). null = that month was never imported (NOT zero). */
  recorded: Record<LeaveKind, RecordedBucket> | null;
  recordedNeedsReview: number | null;
  recordedDetails: RecordedDetail[];
  employeeId: string;
  employeeName: string;
  hasLeaveData: boolean;
  /** null = the source has no leave data at all (NOT zero). */
  byType: Record<LeaveKind, LeaveBucket> | null;
  pendingRequests: number | null;
  rejectedRequests: number | null;
  details: LeaveMonthlyDetail[];
}
export interface LeaveMonthlyReport {
  scope: 'organization' | 'team' | 'self';
  year: number;
  month: number;
  buddhistYear: number;
  periodLabel: string;
  types: { type: LeaveKind; labelTh: string }[];
  recordedCoverage: { periodCovered: boolean; note: string | null };
  recordedTotals: { byType: Record<LeaveKind, RecordedBucket>; needsReviewRecords: number } | null;
  coverage: { leaveRecordsInSystem: number; hasLeaveData: boolean; unmatchedRecordsExcluded: number; note: string | null };
  totals: { byType: Record<LeaveKind, LeaveBucket>; pendingRequests: number; rejectedRequests: number; otherApprovedRequests: number } | null;
  rows: LeaveMonthlyRow[];
  notices: { dayCounting: string; recorded: string };
}

export interface OrganizationReportRow {
  employeeId: string;
  employeeName: string;
  department: string;
  hasMonthlySummary: boolean;
  workDays: number | null;
  present: number | null;
  late: number | null;
  lateMinutes: number | null;
  leaveDaysOnSummary: number | null;
  absent: null;
}

export interface OrganizationReport {
  scope: 'organization' | 'team';
  year: number;
  month: number;
  buddhistYear: number;
  periodLabel: string;
  totals: {
    employeesInScope: number;
    employeesWithData: number;
    employeesWithoutData: number;
    present: number;
    late: number;
    lateMinutes: number;
    leaveDaysOnSummary: number;
    absent: null;
  };
  rows: OrganizationReportRow[];
  notices: { holidaysApplied: boolean; holidayNote: string };
}

export interface LeaveBalanceRow {
  employeeUid: string;
  year: number;
  leaveType: string;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
}
