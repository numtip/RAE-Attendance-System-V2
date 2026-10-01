import type { ApiErrorBody, ApiSuccessBody } from './types';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from '../auth/session';

const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', 'Empty response from server');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, 'INVALID_JSON', 'Invalid JSON response from server');
  }
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return false;
  }
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const payload = await parseJson<ApiSuccessBody<{ accessToken: string; refreshToken: string }> | ApiErrorBody>(
    response,
  );
  if (!response.ok || !payload.success) {
    clearSession();
    return false;
  }
  setTokens(payload.data.accessToken, payload.data.refreshToken);
  return true;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, retryOnUnauthorized = true, headers: initHeaders, ...rest } = options;
  const headers = new Headers(initHeaders);
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (auth) {
    const token = getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && auth && retryOnUnauthorized && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, retryOnUnauthorized: false });
    }
  }

  const payload = await parseJson<ApiSuccessBody<T> | ApiErrorBody>(response);
  if (!payload.success) {
    if (response.status === 401 && auth) {
      clearSession();
    }
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  }
  return payload.data;
}

export const api = {
  login: (email: string, password: string) =>
    apiRequest<import('./types').LoginResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  logout: (refreshToken: string) =>
    apiRequest<{ revoked: boolean }>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  me: () => apiRequest<import('./types').EmployeePublic>('/auth/me'),
  attendanceDaily: (date: string) =>
    apiRequest<import('./types').AttendanceRecord[]>(`/attendance/daily/${date}`),
  attendanceMonthly: (employeeUid: string, year: number, month: number) =>
    apiRequest<import('./types').MonthlySummary>(
      `/attendance/monthly/${employeeUid}/${year}/${month}`,
    ),
  leaveList: (employeeUid?: string) => {
    const query = employeeUid ? `?employeeUid=${encodeURIComponent(employeeUid)}` : '';
    return apiRequest<import('./types').LeaveRow[]>(`/leave${query}`);
  },
  leaveBalance: (employeeUid: string, year: number) =>
    apiRequest<import('./types').LeaveBalanceRow[]>(
      `/leave/balance/${employeeUid}?year=${year}`,
    ),
  leaveHistory: (employeeUid: string) =>
    apiRequest<import('./types').LeaveRow[]>(`/leave/history/${employeeUid}`),
};
