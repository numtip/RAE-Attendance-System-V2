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
  /** คำนำหน้านาม — shown on the profile page only; reports keep the title-free name. */
  titleTh?: string | null;
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
  /** Set by the API: label, source and day detail of the row. HIP/manual rows keep their real approval status. */
  typeLabel?: string;
  statusLabel?: string;
  source?: 'hip' | 'manual' | 'legacy';
  sourceLabel?: string | null;
  partLabel?: string | null;
  dayFraction?: number | null;
  reasonLabels?: string[];
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
  status?: string;
  statusLabel: string;
  partLabel?: string | null;
  dayFraction?: number | null;
  sourceLabel?: string | null;
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
  /** HIP-recorded leave days (0.5 precision, not approval). null = month never imported. */
  leaveRecordedDays: number | null;
  leaveNeedsReview: number | null;
  workDays: number | null;
  lateMinutes: number | null;
  dataThrough?: DataThrough;
  scans: PersonalScan[];
  leaveRows: PersonalLeaveRow[];
  leaveBalances: LeaveBalanceRow[];
  /** Sum over the types with a verified entitlement; null when none (NOT zero). */
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
  leaveRecordedDays: number;
  leaveNeedsReview: number;
  avgPresentPerPerson: number | null;
}
export interface DivisionSummary extends DivisionBucket {
  code: string;
  nameTh: string;
  rows: OrganizationReportRow[];
}
export interface DivisionReport {
  scope: 'organization' | 'team';
  dataThrough?: DataThrough;
  recordedLeaveCovered: boolean;
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
export interface RecordedBucket { days: number; approvedDays: number; awaitingApprovalDays: number; records: number; fullDays: number; halfDays: number }
export type LeaveRecordStatus = 'approved' | 'unverified' | 'needs_review' | 'rejected';
export interface LeaveReportQuery {
  year: number;
  /** null/undefined = the whole year. */
  month?: number | null;
  from?: string;
  to?: string;
  division?: string;
  employeeUid?: string;
  status?: LeaveRecordStatus | '';
  type?: LeaveKind | '';
}
export interface LeaveDayTotals {
  records: number;
  recordedDays: number;
  approvedDays: number;
  awaitingApprovalDays: number;
  needsReviewRecords: number;
  rejectedRecords: number;
}
export interface LeaveDivisionSummary extends LeaveDayTotals {
  code: string;
  nameTh: string;
  headcount: number;
  employeesWithRecords: number;
  byType: Record<LeaveKind, RecordedBucket>;
}
export interface LeaveRecordItem {
  employeeUid: string;
  employeeId: string;
  employeeName: string;
  divisionCode: string;
  divisionName: string;
  date: string;
  dateLabel: string;
  leaveType: LeaveKind;
  typeLabel: string;
  dayPart: 'FULL' | 'AM' | 'PM' | 'UNKNOWN';
  partLabel: string;
  dayFraction: number | null;
  status: LeaveRecordStatus;
  statusLabel: string;
  reasonLabels: string[];
  sourceLabel: string | null;
}
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
  approvalLabel?: string;
  status?: LeaveRecordStatus;
  statusLabel?: string;
}

export type ReviewBucket = 'needs_review' | 'unverified' | 'approved' | 'rejected';
export interface LeaveReviewRow {
  recordUid: string;
  employeeId: string | null;
  employeeName: string | null;
  date: string;
  dateLabel: string;
  leaveType: string;
  typeLabel: string;
  dayPart: 'FULL' | 'AM' | 'PM' | 'UNKNOWN';
  partLabel: string;
  dayFraction: number | null;
  bucket: ReviewBucket;
  approvalStatus: string;
  approvalLabel: string;
  reasonLabels: string[];
  source: 'hip' | 'owner';
  reviewedAt: string | null;
  reviewNote: string | null;
}
export interface LeaveReviewList {
  year: number;
  month: number;
  buddhistYear: number;
  periodLabel: string;
  filter: ReviewBucket | 'all';
  counts: Record<ReviewBucket, number>;
  rows: LeaveReviewRow[];
}
export interface LeaveDecisionInput {
  recordUid: string;
  action: 'approve' | 'reject';
  dayPart?: 'FULL' | 'AM' | 'PM';
  note?: string;
}
export interface LeaveDecisionResult {
  applied: number;
  failed: number;
  results: { recordUid: string; ok: boolean; error?: string }[];
}
export interface LeaveMonthlyRow {
  employeeUid: string;
  divisionCode: string;
  divisionName: string;
  recordedTotals: LeaveDayTotals | null;
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
  /** null = the whole year. */
  month: number | null;
  from: string;
  to: string;
  buddhistYear: number;
  periodLabel: string;
  dataThrough?: DataThrough;
  types: { type: LeaveKind; labelTh: string }[];
  divisions: { code: string; nameTh: string }[];
  statuses: { code: LeaveRecordStatus; label: string }[];
  filters: { division: string | null; employeeUid: string | null; status: string | null; type: string | null; divisionName: string | null; statusLabel: string | null; typeLabel: string | null; active: boolean };
  recordedCoverage: { periodCovered: boolean; coveredMonths: string[]; uncoveredMonths: string[]; note: string | null };
  recordedTotals: { byType: Record<LeaveKind, RecordedBucket>; needsReviewRecords: number; all: LeaveDayTotals } | null;
  byDivision: LeaveDivisionSummary[] | null;
  records: LeaveRecordItem[];
  reconciliation: { recordsMatched: number; recordsInRows: number; recordsInList: number; recordsInDivisions: number; recordedDaysInDivisions: number; recordedDaysInTotals: number; reconciled: boolean };
  coverage: { leaveRecordsInSystem: number; hasLeaveData: boolean; unmatchedRecordsExcluded: number; note: string | null };
  totals: { byType: Record<LeaveKind, LeaveBucket>; pendingRequests: number; rejectedRequests: number; otherApprovedRequests: number } | null;
  rows: LeaveMonthlyRow[];
  notices: { dayCounting: string; recorded: string; recordedCounting: string };
}

/** How far the imported attendance reaches in the month; `partial` = the month is not fully covered. */
export interface DataThrough {
  through: string | null;
  label: string | null;
  partial: boolean;
  note?: string | null;
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
  leaveRecordedDays: number | null;
  leaveNeedsReview: number | null;
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
    leaveRecordedDays: number | null;
    leaveNeedsReview: number | null;
    absent: null;
  };
  rows: OrganizationReportRow[];
  dataThrough?: DataThrough;
  notices: { holidaysApplied: boolean; holidayNote: string };
}

export interface LeaveBalanceRow {
  employeeUid: string;
  year: number;
  leaveType: string;
  typeLabel?: string;
  /** null = no verified entitlement on record (NOT zero). */
  totalDays: number | null;
  /** Approved days only; null = deductions are not tracked for this type. */
  usedDays: number | null;
  pendingDays?: number | null;
  /** null = unavailable (no verified entitlement or untracked deductions). */
  remainingDays: number | null;
  available?: boolean;
  unavailableReason?: 'no_entitlement' | 'deductions_not_tracked' | null;
  /** Present only on fiscal-basis rows (LEAVE_ENTITLEMENT_ENGINE=on). */
  basis?: 'fiscal';
  fiscalYear?: { be: number; start: string; end: string };
  status?: 'ok' | 'unknown' | 'pending_policy' | 'pending_hr_decision' | 'needs_hr' | 'out_of_scope' | 'not_started';
  reasons?: string[];
  /** null = not known; 0 = HR confirmed nothing is carried over. */
  carryoverDays?: number | null;
  entitlementDays?: number | null;
  usageComplete?: boolean;
  uncoveredMonths?: string[];
}
