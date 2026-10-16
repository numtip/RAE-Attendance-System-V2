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

/**
 * R-02 report envelope. The browser never decides whether a month is final: `report.isFinal` and
 * `report.computationStatus` come from the server, and a `partial` / `pending_policy` / `not_derived`
 * month must be shown as such rather than as a set of final figures.
 */
export type ReportComputationStatus =
  | 'calculated'
  | 'no_data'
  | 'insufficient_data'
  | 'partial'
  | 'pending_policy'
  | 'failed'
  | 'not_derived';

export interface ReportCaveat {
  code: string;
  detail: string | null;
}

export interface ReportHeader {
  kind: 'day' | 'month' | 'academic_year';
  period: Record<string, unknown>;
  population: { employees: number; employeeUid: string; dayRows: number };
  ruleVersions: string[];
  /** Newest STORED day included, or null when there is none. Never the requested date. */
  dateCutoff: string | null;
  computationStatus: ReportComputationStatus;
  isFinal: boolean;
  statusReasons: string[];
  caveats: ReportCaveat[];
  generatedFrom: string;
}

export interface MonthReportRow {
  year: number;
  month: number;
  computationStatus: ReportComputationStatus;
  isFinal: boolean;
  totalWorkDays: number;
  totalPresent: number;
  totalLate: number;
  totalAbsent: number;
  totalLeave: number;
  totalLateMinutes: number;
  totalEarlyMinutes: number;
  totalWorkHours: number;
  expectedWorkingDays: number | null;
  pendingDays: number;
  holidayDays: number;
  ruleVersions: string[];
  dayCounts: Record<string, unknown>;
  derivationNotes: string | null;
  calculatedAt: string | null;
  sourceKind: string | null;
}

export interface AttendanceMonthReport {
  report: ReportHeader;
  /** null when the month was never derived — deliberately absent, never a month of zeros. */
  month: MonthReportRow | null;
  days: Array<{
    date: string;
    status: string | null;
    computationStatus: ReportComputationStatus;
    isFinal: boolean;
  }>;
  dayCounts: {
    rows: number;
    byStatus: Record<string, number>;
    byComputationStatus: Record<string, number>;
  };
}

/**
 * R-03 export surface. A report export is a binary body, not JSON, so it cannot go through `apiRequest`;
 * `AttendanceExportFile` is what the client hands back after it has read the filename off the response.
 */
export type AttendanceReportKind = 'day' | 'month' | 'academic_year';

export type AttendanceExportFormat = 'pdf' | 'xlsx';

/** Period argument required by each report kind (Gregorian/ISO values only — never a Buddhist-Era year). */
export type AttendanceExportPeriodFor<K extends AttendanceReportKind> = K extends 'day'
  ? { date: string }
  : K extends 'month'
    ? { year: number; month: number }
    : { year: number };

export interface AttendanceExportFile {
  /** The binary body (application/pdf or the XLSX content type). */
  blob: Blob;
  /** Sanitised filename safe to hand to the browser download dialog. */
  fileName: string;
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

export interface LeaveBalanceRow {
  employeeUid: string;
  year: number;
  leaveType: string;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
}
