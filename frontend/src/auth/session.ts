import type { LoginEmployee } from '../api/types';

const ACCESS_KEY = 'rae_v2_access_token';
const REFRESH_KEY = 'rae_v2_refresh_token';
const EMPLOYEE_KEY = 'rae_v2_employee';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function getStoredEmployee(): LoginEmployee | null {
  const raw = localStorage.getItem(EMPLOYEE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as LoginEmployee;
  } catch {
    return null;
  }
}

export function setSession(accessToken: string, refreshToken: string, employee: LoginEmployee): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
  localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(employee));
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EMPLOYEE_KEY);
}

export function isAuthenticated(): boolean {
  return Boolean(getAccessToken());
}
