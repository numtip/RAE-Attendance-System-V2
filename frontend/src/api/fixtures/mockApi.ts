import { getAccessToken, getRefreshToken, getStoredEmployee, setTokens } from '../../auth/session';
import { ApiError } from '../errors';
import type {
  AttendanceMonthReport,
  AttendanceRecord,
  EmployeePublic,
  LeaveBalanceRow,
  LeaveRow,
  LoginResult,
  MonthReportRow,
  MonthlySummary,
  ReportComputationStatus,
} from '../types';
import {
  fixtureBalances,
  fixtureEmployees,
  fixtureLeave,
  fixtureMonthReportOverrides,
  fixtureMonthly,
  publicEmployee,
} from './data';

type RefreshRecord = {
  employeeUid: string;
  email: string;
  role: string;
  expiresAt: string;
  revokedAt: string | null;
};

const refreshTokens = new Map<string, RefreshRecord>();

function randomToken(): string {
  return crypto.randomUUID();
}

function parseBody<T>(body: unknown): T {
  if (body === undefined || body === null) {
    return {} as T;
  }
  if (typeof body === 'string') {
    return JSON.parse(body) as T;
  }
  return body as T;
}

function authFromSession(): { employeeUid: string; email: string; role: string } {
  const token = getAccessToken();
  const employee = getStoredEmployee();
  if (!token || !employee) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication is required');
  }
  return {
    employeeUid: employee.employeeUid,
    email: employee.email,
    role: employee.role,
  };
}

function assertCanReadEmployee(auth: { employeeUid: string; role: string }, employeeUid: string): void {
  if (auth.employeeUid === employeeUid) return;
  throw new ApiError(403, 'FORBIDDEN', 'This record is outside your scope');
}

function findEmployeeByEmail(email: string) {
  return fixtureEmployees.find((row) => row.email === email) ?? null;
}

function findEmployeePublic(employeeUid: string): EmployeePublic | null {
  const row = fixtureEmployees.find((item) => item.employeeUid === employeeUid);
  return row ? publicEmployee(row) : null;
}

async function handleLogin(body: unknown): Promise<LoginResult> {
  const { email, password } = parseBody<{ email?: string; password?: string }>(body);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A valid email is required');
  }
  if (!password || String(password).length < 6) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Password must be at least 6 characters');
  }
  const employee = findEmployeeByEmail(email.trim());
  const matches = employee ? employee.password === String(password) : false;
  if (!employee || !matches) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (employee.lockedUntil && new Date(employee.lockedUntil).getTime() > Date.now()) {
    throw new ApiError(403, 'ACCOUNT_LOCKED', 'This account is locked');
  }
  const refreshToken = randomToken();
  refreshTokens.set(refreshToken, {
    employeeUid: employee.employeeUid,
    email: employee.email,
    role: employee.role,
    expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    revokedAt: null,
  });
  return {
    accessToken: randomToken(),
    refreshToken,
    employee: {
      employeeUid: employee.employeeUid,
      email: employee.email,
      role: employee.role,
    },
  };
}

async function handleRefresh(body: unknown): Promise<{ accessToken: string; refreshToken: string }> {
  const { refreshToken } = parseBody<{ refreshToken?: string }>(body);
  if (!refreshToken) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'refreshToken is required');
  }
  const current = refreshTokens.get(refreshToken);
  if (!current || current.revokedAt || new Date(current.expiresAt).getTime() <= Date.now()) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
  current.revokedAt = new Date().toISOString();
  const nextToken = randomToken();
  refreshTokens.set(nextToken, {
    employeeUid: current.employeeUid,
    email: current.email,
    role: current.role,
    expiresAt: current.expiresAt,
    revokedAt: null,
  });
  return {
    accessToken: randomToken(),
    refreshToken: nextToken,
  };
}

async function handleLogout(body: unknown): Promise<{ revoked: boolean }> {
  const auth = authFromSession();
  const { refreshToken } = parseBody<{ refreshToken?: string }>(body);
  if (!refreshToken) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'refreshToken is required');
  }
  const current = refreshTokens.get(refreshToken);
  if (!current || current.employeeUid !== auth.employeeUid) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
  current.revokedAt = new Date().toISOString();
  return { revoked: true };
}

async function handleMe(): Promise<EmployeePublic> {
  const auth = authFromSession();
  const employee = findEmployeePublic(auth.employeeUid);
  if (!employee) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  return employee;
}

async function handleAttendanceDaily(_date: string): Promise<AttendanceRecord[]> {
  authFromSession();
  throw new ApiError(
    403,
    'FORBIDDEN',
    'Daily attendance for other employees is outside your scope',
  );
}

async function handleAttendanceMonthly(
  employeeUid: string,
  year: number,
  month: number,
): Promise<MonthlySummary> {
  const auth = authFromSession();
  assertCanReadEmployee(auth, employeeUid);
  if (!findEmployeePublic(employeeUid)) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  const summary = fixtureMonthly.find(
    (row) => row.employeeUid === employeeUid && row.year === year && row.month === month,
  );
  if (!summary) {
    throw new ApiError(404, 'NOT_FOUND', 'Monthly summary was not found');
  }
  return summary;
}

/** Days of a synthetic month that could not be judged, so a `partial` month is visible in review mode. */
const SYNTHETIC_UNJUDGED_DAYS = ['2026-07-06', '2026-07-20'];

/**
 * A stored day for every calendar day of the month, mirroring what a whole-month recalculation writes:
 * weekdays judged, weekends classified as non-working, and the listed days withheld (`insufficient_data`).
 */
function syntheticMonthDays(year: number, month: number): AttendanceMonthReport['days'] {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows: AttendanceMonthReport['days'] = [];
  for (let day = 1; day <= total; day += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const unjudged = SYNTHETIC_UNJUDGED_DAYS.includes(date);
    rows.push({
      date,
      status: unjudged ? 'pending' : isWeekend ? 'holiday' : 'present',
      computationStatus: unjudged ? 'insufficient_data' : 'calculated',
      isFinal: !unjudged,
    });
  }
  return rows;
}

/**
 * R-02 report in review mode.
 *
 * The completeness verdict is the whole point, so this mirror of the backend NEVER decides that a month is
 * final on its own: a month is `calculated` only when the fixture really has a stored summary for it, and
 * a month listed in `fixtureMonthReportOverrides` keeps the non-final status it is given.
 *
 * The saved-days list is generated so it agrees with the totals it accompanies: a month that reports
 * `dayRows: 0` has no stored days (a bare seed row, exactly like the backend fixture), and the synthetic
 * partial month really does carry one stored day per calendar day.
 */
function buildMonthReport(employeeUid: string, year: number, month: number): AttendanceMonthReport {
  const key = `${year}-${month}`;
  const override = fixtureMonthReportOverrides[key];
  const stored = fixtureMonthly.find(
    (row) => row.employeeUid === employeeUid && row.year === year && row.month === month,
  );

  const computationStatus: ReportComputationStatus = override
    ? override.status
    : stored
      ? 'calculated'
      : 'not_derived';

  const body: MonthReportRow | null = override
    ? override.month
    : stored
      ? {
        year: stored.year,
        month: stored.month,
        computationStatus: 'calculated',
        isFinal: true,
        totalWorkDays: stored.totalWorkDays,
        totalPresent: stored.totalPresent,
        totalLate: stored.totalLate,
        totalAbsent: stored.totalAbsent,
        totalLeave: stored.totalLeave,
        totalLateMinutes: stored.totalLateMinutes,
        totalEarlyMinutes: 0,
        totalWorkHours: stored.totalWorkHours,
        // This seeded fixture month has no stored daily rows and no rule provenance, so the expected-days
        // figure is NOT derivable and no rule version can be named. Reported as such, not invented.
        expectedWorkingDays: null,
        pendingDays: 0,
        holidayDays: 0,
        ruleVersions: [],
        dayCounts: {},
        derivationNotes: 'fixture month: a seed row with no stored daily rows in review mode',
        calculatedAt: null,
        sourceKind: 'seed',
      }
      : null;

  const days = override ? syntheticMonthDays(year, month) : [];
  const statusReasons = override
    ? override.reasons
    : stored
      ? []
      : ['month_never_derived'];

  return {
    report: {
      kind: 'month',
      period: {
        from: `${year}-${String(month).padStart(2, '0')}-01`,
        to: `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate())}`,
        year,
        month,
        key: `${year}-${String(month).padStart(2, '0')}`,
      },
      population: { employees: 1, employeeUid, dayRows: days.length },
      ruleVersions: body?.ruleVersions ?? [],
      dateCutoff: days.length > 0 ? days[days.length - 1].date : null,
      computationStatus,
      isFinal: computationStatus === 'calculated' && body != null,
      statusReasons,
      // The holiday caveat narrows an EXPECTED-DAYS figure, so it is only raised when one was derived.
      caveats: body?.expectedWorkingDays != null
        ? [{
          code: 'HOLIDAY_CALENDAR_EMPTY',
          detail: 'No approved holiday covers this period, so expected working days count the working week only.',
        }]
        : [],
      generatedFrom: 'stored_daily_attendance',
    },
    month: body,
    days,
    dayCounts: {
      rows: days.length,
      byStatus: days.reduce<Record<string, number>>((counts, row) => {
        counts[row.status ?? 'unknown'] = (counts[row.status ?? 'unknown'] ?? 0) + 1;
        return counts;
      }, {}),
      byComputationStatus: days.reduce<Record<string, number>>((counts, row) => {
        counts[row.computationStatus] = (counts[row.computationStatus] ?? 0) + 1;
        return counts;
      }, {}),
    },
  };
}

async function handleAttendanceMonthReport(
  employeeUid: string,
  year: number,
  month: number,
): Promise<AttendanceMonthReport> {
  const auth = authFromSession();
  assertCanReadEmployee(auth, employeeUid);
  if (!findEmployeePublic(employeeUid)) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100
    || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'REPORT_INVALID_PERIOD', 'year and month must form a real period');
  }
  return buildMonthReport(employeeUid, year, month);
}

async function handleLeaveList(query: string): Promise<LeaveRow[]> {
  const auth = authFromSession();
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const target = params.get('employeeUid') || auth.employeeUid;
  assertCanReadEmployee(auth, target);
  return fixtureLeave.filter((row) => row.employeeUid === target);
}

async function handleLeaveBalance(employeeUid: string, year: number): Promise<LeaveBalanceRow[]> {
  const auth = authFromSession();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'year is invalid');
  }
  assertCanReadEmployee(auth, employeeUid);
  if (!findEmployeePublic(employeeUid)) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  return fixtureBalances.filter((row) => row.employeeUid === employeeUid && row.year === year);
}

async function handleLeaveHistory(employeeUid: string): Promise<LeaveRow[]> {
  const auth = authFromSession();
  assertCanReadEmployee(auth, employeeUid);
  if (!findEmployeePublic(employeeUid)) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  return fixtureLeave.filter((row) => row.employeeUid === employeeUid);
}

export async function fixtureApiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    auth?: boolean;
    retryOnUnauthorized?: boolean;
  } = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const auth = options.auth ?? true;

  if (method === 'POST' && path === '/auth/login') {
    return (await handleLogin(options.body)) as T;
  }

  if (method === 'POST' && path === '/auth/refresh') {
    const result = await handleRefresh(options.body);
    setTokens(result.accessToken, result.refreshToken);
    return result as T;
  }

  if (auth && method === 'GET' && path === '/auth/me') {
    return (await handleMe()) as T;
  }

  if (auth && method === 'POST' && path === '/auth/logout') {
    return (await handleLogout(options.body)) as T;
  }

  const dailyMatch = path.match(/^\/attendance\/daily\/(\d{4}-\d{2}-\d{2})$/);
  if (auth && method === 'GET' && dailyMatch) {
    return (await handleAttendanceDaily(dailyMatch[1])) as T;
  }

  const monthlyMatch = path.match(/^\/attendance\/monthly\/([^/]+)\/(\d+)\/(\d+)$/);
  if (auth && method === 'GET' && monthlyMatch) {
    return (await handleAttendanceMonthly(
      decodeURIComponent(monthlyMatch[1]),
      Number(monthlyMatch[2]),
      Number(monthlyMatch[3]),
    )) as T;
  }

  const monthReportMatch = path.match(/^\/attendance\/report\/month\/([^/]+)\/(\d+)\/(\d+)$/);
  if (auth && method === 'GET' && monthReportMatch) {
    return (await handleAttendanceMonthReport(
      decodeURIComponent(monthReportMatch[1]),
      Number(monthReportMatch[2]),
      Number(monthReportMatch[3]),
    )) as T;
  }

  const leaveListMatch = path.match(/^\/leave(\?.*)?$/);
  if (auth && method === 'GET' && leaveListMatch) {
    const query = leaveListMatch[1] ?? '';
    return (await handleLeaveList(query)) as T;
  }

  const balanceMatch = path.match(/^\/leave\/balance\/([^/?]+)\?year=(\d+)$/);
  if (auth && method === 'GET' && balanceMatch) {
    return (await handleLeaveBalance(decodeURIComponent(balanceMatch[1]), Number(balanceMatch[2]))) as T;
  }

  const historyMatch = path.match(/^\/leave\/history\/([^/]+)$/);
  if (auth && method === 'GET' && historyMatch) {
    return (await handleLeaveHistory(decodeURIComponent(historyMatch[1]))) as T;
  }

  // R-03 exports are binary and review mode has no backend, so we never fabricate a PDF/XLSX here.
  // The client refuses in review mode before it reaches this dispatch; this keeps the fixture honest too.
  if (auth && method === 'GET' && path.startsWith('/attendance/export/')) {
    throw new ApiError(
      501,
      'EXPORT_UNAVAILABLE_REVIEW_MODE',
      'Exports need the API; review mode has no backend.',
    );
  }

  if (
    auth &&
    options.retryOnUnauthorized !== false &&
    method !== 'POST' &&
    getRefreshToken() &&
    !getAccessToken()
  ) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication is required');
  }

  throw new ApiError(404, 'NOT_FOUND', `Fixture API has no handler for ${method} ${path}`);
}
