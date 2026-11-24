export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
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

// ---- attendance analytics (organization / department / individual) ----

export interface AttendanceAnalyticsQuery {
  year: number;
  /** null = the whole year. */
  month: number | null;
  from?: string;
  to?: string;
  division?: string;
  employeeUid?: string;
}

export interface AttendanceMonthCoverage {
  month: string;
  covered: boolean;
  through: string | null;
  throughLabel: string | null;
  partial: boolean;
  expectedDays: number | null;
  calculatedDays: number | null;
  workdays: number | null;
  leaveDays: number | null;
  lateArrivals: number | null;
  earlyDepartures: number | null;
  lateMinutes: number | null;
  noDataDays: number | null;
  completeness: number | null;
}

export interface AttendanceAnalyticsRow {
  employeeUid: string;
  employeeId: string;
  employeeName: string;
  divisionCode: string;
  divisionName: string;
  hasData: boolean;
  expectedDays: number;
  calculatedDays: number;
  workdays: number;
  leaveDays: number;
  lateArrivals: number;
  earlyDepartures: number;
  lateMinutes: number;
  earlyMinutes: number;
  noDataDays: number;
  pendingPolicyDays: number;
  missingDays: number;
  /** Share of the weekday denominator with computed data; null = no denominator (no data). */
  completeness: number | null;
  /** HIP-recorded leave context: excluded from every attendance KPI until approved. */
  leaveApprovedDays: number;
  leaveAwaitingDays: number;
  leaveNeedsReviewRecords: number;
}

export interface AttendanceDivisionSummary extends AttendanceAnalyticsRow {
  code: string;
  nameTh: string;
  headcount: number;
  employeesWithRecords: number;
}

export interface AttendanceAnalyticsReport {
  scope: 'organization' | 'team' | 'self';
  year: number;
  month: number | null;
  from: string;
  to: string;
  buddhistYear: number;
  periodLabel: string;
  filters: { division: string | null; employeeUid: string | null; divisionName: string | null; active: boolean };
  divisions: { code: string; nameTh: string }[];
  dataThrough: DataThrough;
  coverage: {
    holidayCalendarConfigured: boolean;
    workdayBasisNote: string;
    noAbsentNote: string;
    quarantinedNote: string;
    leaveApprovalNote: string;
    quarantinedScansExcluded: { count: number; countedInKpis: boolean } | null;
    months: AttendanceMonthCoverage[];
    uncoveredMonths: string[];
    partialMonths: string[];
    leaveCoveredMonths: string[];
  };
  totals: {
    employeesInScope: number;
    employeesWithRecords: number;
    employeesWithoutRecords: number;
    employeeCoverage: { withRecords: number; total: number; ratio: number | null };
    expectedDays: number;
    calculatedDays: number;
    workdays: number;
    leaveDays: number;
    lateArrivals: number;
    earlyDepartures: number;
    lateMinutes: number;
    earlyMinutes: number;
    noDataDays: number;
    pendingPolicyDays: number;
    otherDays: number;
    missingDays: number;
    completeness: number | null;
    leaveApprovedDays: number;
    leaveAwaitingDays: number;
    leaveNeedsReviewRecords: number;
    absent: null;
  };
  byDivision: AttendanceDivisionSummary[];
  rows: AttendanceAnalyticsRow[];
  reconciliation: { daysInTotals: number; daysInDivisions: number; daysInRows: number; daysInMonths: number; reconciled: boolean };
  notices: { holidayNote: string; countingBasis: string; noAbsent: string };
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

// ---------- Fiscal-year entitlement overview (one request for everyone in scope) ----------
export type EntitlementStatus = 'ok' | 'unknown' | 'pending_policy' | 'pending_hr_decision' | 'needs_hr' | 'out_of_scope' | 'not_started';
export type EntitlementScope = 'in_policy' | 'unconfirmed' | 'excluded';
export interface EntitlementCell {
  status: EntitlementStatus;
  source: 'hr_verified' | 'computed' | null;
  available: boolean;
  /** null = not determined (NOT zero). */
  entitlementDays: number | null;
  carryoverDays: number | null;
  totalDays: number | null;
  usedDays: number | null;
  pendingDays: number | null;
  remainingDays: number | null;
  usageComplete: boolean;
  missing: string[];
  reasons: string[];
  flags: string[];
}
export interface EntitlementProfile {
  hireDate: string | null;
  continuousServiceStart: string | null;
  appointmentKind: 'first' | 'rehire_after_resignation' | 'rehire_after_dismissal' | 'other' | null;
  eligibilityConfirmed: boolean | null;
  eligibilityReference: string | null;
}
export interface EntitlementRow {
  employeeUid: string;
  employeeId: string;
  name: string;
  employeeType: string;
  division: { code: string; nameTh: string };
  scope: EntitlementScope;
  missing: string[];
  policy: EntitlementPolicy;
  types: Partial<Record<LeaveKind, EntitlementCell>>;
  /** Only for the executive with an organization grant. */
  profile?: EntitlementProfile;
  /** Entitlement rows the owner entered / imported for this year (executive only). */
  stored?: Partial<Record<LeaveKind, EntitlementStored>>;
}
export interface EntitlementTypeSummary {
  label: string;
  byStatus: Record<string, number>;
  determined: number;
  entitlementDays: number;
  usedDays: number;
  remainingDays: number;
  /** What the engine still needs, counted over the people in or awaiting the policy (never contract staff). */
  missing: Record<string, number>;
}
export interface EntitlementStored {
  entitlementDays: number | null;
  carryoverDays: number | null;
  usageBaselineDays: number | null;
  usageBaselineThrough: string | null;
}
export type PolicyFamily = 'university' | 'section_employee' | 'section_contract';
/** The policy of one person and the facts it needs (the screens ask for these and nothing else). */
export interface EntitlementPolicy {
  family: PolicyFamily | null;
  id: string | null;
  labelTh: string | null;
  requires: { hireDateFor: LeaveKind[]; continuousService: boolean; appointmentKind: boolean; carryover: boolean } | null;
}
export interface PolicyReadiness { people: number; unconfirmed: number; fullyDetermined: number }
export interface EntitlementOverview {
  fiscalYear: { be: number; start: string; end: string };
  flag: 'shadow' | 'on';
  canEdit: boolean;
  types: { type: LeaveKind; labelTh: string }[];
  divisions: { code: string; nameTh: string }[];
  summary: {
    headcount: number; inPolicy: number; excluded: number; unconfirmed: number; fullyDetermined: number;
    byType: Record<LeaveKind, EntitlementTypeSummary>;
    missing: Record<string, number>;
    byPolicy: Record<PolicyFamily | 'unmapped', PolicyReadiness>;
  };
  rows: EntitlementRow[];
}
export interface EntitlementFactsInput {
  hireDate?: string | null;
  continuousServiceStart?: string | null;
  appointmentKind?: EntitlementProfile['appointmentKind'];
  eligibility?: { confirmed: boolean | null; reference?: string };
  entitlements?: Array<
    | { fiscalYearBe: number; leaveType: LeaveKind; remove: true }
    | { fiscalYearBe: number; leaveType: LeaveKind; entitlementDays: number; carryoverDays?: number | null; usageBaselineDays?: number | null; usageBaselineThrough?: string | null }
  >;
}

// ---------- Owner bulk data management ----------
export interface ImportFileSummary {
  rows: number;
  fileErrors: string[];
  errors: Record<string, number>;
  warnings: Record<string, number>;
  matched: number;
  unchanged: number;
  toApply: number;
  alreadyApplied: boolean;
}
export interface ImportFinding { kind: 'profile' | 'entitlement'; line: number; level: 'error' | 'warning'; code: string }
export interface ImportResult {
  mode: 'dry-run' | 'apply';
  ok: boolean;
  written: boolean;
  alreadyApplied: boolean;
  blockingErrors: number;
  refused: string | null;
  files: Partial<Record<'profile' | 'entitlement', ImportFileSummary>>;
  preview: { fiscalYearBe: number; people: number; before: Record<string, Record<string, number>>; after: Record<string, Record<string, number>> } | null;
  applied: Record<string, { rowsApplied: number; rowsUnchanged: number; auditRows: number }> | null;
  findings: ImportFinding[];
  findingsTruncated: boolean;
}
export interface BulkEligibilityResult { requested: number; changed: number; unchanged: number; failed: { employeeUid: string; code: string }[]; reference: string | null }
