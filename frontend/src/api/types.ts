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
