import { getAccessToken, getRefreshToken, getStoredEmployee, setTokens } from '../../auth/session';
import { ApiError } from '../errors';
import type {
  AttendanceRecord,
  EmployeePublic,
  LeaveBalanceRow,
  LeaveRow,
  LoginResult,
  MonthlySummary,
} from '../types';
import {
  fixtureAttendance,
  fixtureBalances,
  fixtureEmployees,
  fixtureLeave,
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
  if (auth.role === 'admin' || auth.role === 'manager' || auth.employeeUid === employeeUid) {
    return;
  }
  throw new ApiError(403, 'FORBIDDEN', 'You can only read your own attendance and leave records');
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

async function handleAttendanceDaily(date: string): Promise<AttendanceRecord[]> {
  const auth = authFromSession();
  if (auth.role !== 'admin' && auth.role !== 'manager') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Daily attendance for all employees requires a manager or admin role',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
  return fixtureAttendance.filter((row) => row.date === date);
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
