import type {
  ApiErrorBody,
  ApiSuccessBody,
  AttendanceExportFile,
  AttendanceExportFormat,
  AttendanceExportPeriodFor,
  AttendanceReportKind,
} from './types';
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

/* ---------------------------------------------------------------------------------------------------
 * R-03 binary export.
 *
 * An export is a file, so it cannot reuse `apiRequest` (which always parses a JSON envelope). The bearer
 * token goes in the Authorization header — NEVER in the query string. A non-OK response still carries the
 * usual JSON error envelope, which we surface as an `ApiError` so the UI can show `error.code`/`message`.
 * ------------------------------------------------------------------------------------------------- */

const EXPORT_EXTENSION: Record<AttendanceExportFormat, string> = { pdf: 'pdf', xlsx: 'xlsx' };

/** Loose runtime view of the discriminated period union, for path/filename building. */
type ExportPeriod = { date: string } | { year: number; month: number } | { year: number };

/**
 * The server's `Content-Disposition` filename is untrusted input: drop any directory component (Windows or
 * POSIX), strip every character that is not conservatively safe, refuse a result that is empty or dot-only,
 * and cap the length. Falls back to a locally built ASCII name when the header is missing or hostile.
 */
function sanitizeExportFileName(candidate: string | null, fallback: string): string {
  const raw = (candidate ?? '').trim().replace(/.*[\\/]/, '');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 120);
  if (!cleaned || !/[A-Za-z0-9]/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function ensureExportExtension(name: string, format: AttendanceExportFormat): string {
  const ext = EXPORT_EXTENSION[format];
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

function exportFallbackFileName(
  kind: AttendanceReportKind,
  period: ExportPeriod,
  employeeUid: string,
  format: AttendanceExportFormat,
): string {
  const uid = employeeUid.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'employee';
  let periodSegment: string;
  if ('date' in period) {
    periodSegment = period.date;
  } else if ('month' in period) {
    periodSegment = `${period.year}-${String(period.month).padStart(2, '0')}`;
  } else {
    periodSegment = String(period.year);
  }
  const safePeriod = periodSegment.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20) || 'period';
  return `attendance-report-${kind}-${safePeriod}-${uid}.${EXPORT_EXTENSION[format]}`;
}

function buildExportPath(
  employeeUid: string,
  kind: AttendanceReportKind,
  period: ExportPeriod,
  format: AttendanceExportFormat,
): string {
  const uid = encodeURIComponent(employeeUid);
  const query = `?format=${encodeURIComponent(format)}`;
  if (kind === 'day') {
    const date = 'date' in period ? period.date : '';
    return `/attendance/export/day/${uid}/${encodeURIComponent(date)}${query}`;
  }
  if (kind === 'month') {
    const year = 'year' in period ? String(period.year) : '';
    const month = 'month' in period ? String(period.month) : '';
    return `/attendance/export/month/${uid}/${year}/${month}${query}`;
  }
  const year = 'year' in period ? String(period.year) : '';
  return `/attendance/export/academic-year/${uid}/${year}${query}`;
}

/** `filename*=UTF-8''...` wins over the quoted `filename=` form; anything else is ignored. */
function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const value = star[1].trim().replace(/^["']|["']$/g, '');
    const encoded = value.includes("''") ? value.slice(value.indexOf("''") + 2) : value;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) {
    return (plain[1] ?? plain[2] ?? '').trim() || null;
  }
  return null;
}

/** Parse the standard JSON error envelope; never surface raw server text. */
async function readExportError(response: Response, fallbackMessage: string): Promise<ApiError> {
  let code = 'EXPORT_FAILED';
  let message = fallbackMessage;
  try {
    const text = await response.text();
    if (text) {
      const payload = JSON.parse(text) as Partial<ApiErrorBody>;
      if (payload && payload.error) {
        code = payload.error.code || code;
        message = payload.error.message || message;
      }
    }
  } catch {
    // Body was not JSON: keep the fallback so no raw server text reaches the UI.
  }
  if (response.status === 401) {
    clearSession();
  }
  return new ApiError(response.status, code, message);
}

/** Binary GET that carries the bearer token and mirrors `apiRequest`'s one-shot 401 refresh-and-retry. */
async function exportFetch(path: string, retryOnUnauthorized: boolean): Promise<Response> {
  const headers = new Headers();
  const token = getAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(`${API_BASE}${path}`, { headers });
  if (response.status === 401 && retryOnUnauthorized && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return exportFetch(path, false);
    }
  }
  return response;
}

/**
 * R-03: download a report export. Returns the Blob plus a sanitised filename; the caller owns the object
 * URL and MUST revoke it.
 */
export async function downloadAttendanceReport<K extends AttendanceReportKind>(
  employeeUid: string,
  kind: K,
  period: AttendanceExportPeriodFor<K>,
  format: AttendanceExportFormat,
): Promise<AttendanceExportFile> {
  if (isReviewFixtureMode) {
    // Same status + code as the fixture dispatcher's guard, so review mode reports one consistent reason.
    throw new ApiError(
      501,
      'EXPORT_UNAVAILABLE_REVIEW_MODE',
      'Exports need the API; review mode has no backend.',
    );
  }
  const loose = period as unknown as ExportPeriod;
  const response = await exportFetch(buildExportPath(employeeUid, kind, loose, format), true);
  if (!response.ok) {
    throw await readExportError(response, 'The export could not be downloaded');
  }
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
  if (contentType.includes('json')) {
    // A 200 with a JSON body means the server did not return a file; treat it as an error, not a download.
    throw await readExportError(response, 'The server returned a JSON body instead of a file');
  }
  const blob = await response.blob();
  const fallback = exportFallbackFileName(kind, loose, employeeUid, format);
  const fromHeader = sanitizeExportFileName(
    fileNameFromContentDisposition(response.headers.get('Content-Disposition')),
    fallback,
  );
  return { blob, fileName: ensureExportExtension(fromHeader, format) };
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
  /**
   * R-02 report surface. Preferred over `attendanceMonthly`: it carries `computationStatus` and `isFinal`,
   * so the UI can refuse to present an incomplete month as a final one.
   */
  attendanceMonthReport: (employeeUid: string, year: number, month: number) =>
    apiRequest<import('./types').AttendanceMonthReport>(
      `/attendance/report/month/${employeeUid}/${year}/${month}`,
    ),
  /**
   * R-03 binary export. Returns a Blob + filename so the caller can trigger the download and revoke the
   * object URL. Not routed through `apiRequest` because the body is a file, not a JSON envelope.
   */
  attendanceReportExport: downloadAttendanceReport,
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
