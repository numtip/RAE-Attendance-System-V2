import type { ApiErrorBody, ApiSuccessBody } from './types';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from '../auth/session';
import { isReviewFixtureMode } from '../config/reviewMode';
import { ApiError } from './errors';
import { fixtureApiRequest } from './fixtures/mockApi';

export { ApiError };

const API_BASE = '/api/v1';

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
  if (isReviewFixtureMode) {
    try {
      await fixtureApiRequest<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
        auth: false,
      });
      return true;
    } catch {
      clearSession();
      return false;
    }
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
  if (isReviewFixtureMode) {
    const { auth = true, retryOnUnauthorized = true } = options;
    try {
      return await fixtureApiRequest<T>(path, options);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        auth &&
        retryOnUnauthorized &&
        getRefreshToken()
      ) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return apiRequest<T>(path, { ...options, retryOnUnauthorized: false });
        }
      }
      if (error instanceof ApiError && error.status === 401 && auth) {
        clearSession();
      }
      throw error;
    }
  }

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
  /**
   * Redeem the single-use 45-second handoff code issued by `/api/v1/auth/sso/callback`.
   */
  ssoExchange: (code: string) =>
    apiRequest<import('./types').LoginResult>('/auth/sso/exchange', {
      method: 'POST',
      body: { code },
      auth: false,
      retryOnUnauthorized: false,
    }),
  ssoMe: () => apiRequest<import('./types').EmployeePublic>('/auth/sso/me'),
  /**
   * SSO logout. The server revokes the access and refresh tokens BEFORE this resolves, so the session is already
   * dead when the browser leaves the app. Returns the validated MJU signout URL and post-signout landing page.
   */
  ssoLogout: (refreshToken: string) =>
    apiRequest<{ revoked: boolean; signoutUrl?: string; afterSignoutUrl?: string }>('/auth/sso/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  me: () => apiRequest<import('./types').EmployeePublic>('/auth/me'),
  attendanceDaily: (date: string) =>
    apiRequest<import('./types').AttendanceRecord[]>(`/attendance/daily/${date}`),
  attendanceMe: (date: string) =>
    apiRequest<import('./types').AttendanceRecord[]>(`/attendance/me/${date}`),
  attendanceMonthly: (employeeUid: string, year: number, month: number) =>
    apiRequest<import('./types').MonthlySummary>(
      `/attendance/monthly/${employeeUid}/${year}/${month}`,
    ),
  employeeAttendance: (employeeUid: string) =>
    apiRequest<import('./types').AttendanceRecord[]>(`/employees/${encodeURIComponent(employeeUid)}/attendance`),
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
  organizationReport: (year: number, month: number) =>
    apiRequest<import('./types').OrganizationReport>(`/reports/organization?year=${year}&month=${month}`),
  divisionReport: (year: number, month: number) =>
    apiRequest<import('./types').DivisionReport>(`/reports/divisions?year=${year}&month=${month}`),
  leaveReviewList: (year: number, month: number, filter: string) =>
    apiRequest<import('./types').LeaveReviewList>(`/leave-review?year=${year}&month=${month}&filter=${filter}`),
  leaveReviewDecide: (decisions: import('./types').LeaveDecisionInput[]) =>
    apiRequest<import('./types').LeaveDecisionResult>('/leave-review/decisions', { method: 'POST', body: { decisions } }),
  leaveMonthlyReport: (year: number, month: number) =>
    apiRequest<import('./types').LeaveMonthlyReport>(`/reports/leave-monthly?year=${year}&month=${month}`),
  personalReport: (year: number, month: number) =>
    apiRequest<import('./types').PersonalReport>(`/reports/personal?year=${year}&month=${month}`),
};

export async function downloadPersonalReport(year: number, month: number, format: 'pdf' | 'xlsx'): Promise<void> {
  return downloadReport('personal', year, month, format);
}

export async function downloadOrganizationReport(year: number, month: number, format: 'pdf' | 'xlsx'): Promise<void> {
  return downloadReport('organization', year, month, format);
}

export async function downloadLeaveMonthly(year: number, month: number, format: 'pdf' | 'xlsx'): Promise<void> {
  return downloadReport('leave-monthly', year, month, format);
}

async function downloadReport(kind: 'personal' | 'organization' | 'leave-monthly', year: number, month: number, format: 'pdf' | 'xlsx'): Promise<void> {
  const token = getAccessToken();
  const response = await fetch(
    `${API_BASE}/reports/${kind}/export?year=${year}&month=${month}&format=${format}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'EXPORT_FAILED',
      response.status === 403 ? 'ไม่มีสิทธิ์ส่งออกรายงานนี้' : 'Export failed',
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attendance-${kind === 'organization' ? 'org-' : ''}${year + 543}-${String(month).padStart(2, '0')}.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}
