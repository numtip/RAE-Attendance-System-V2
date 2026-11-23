import { getAccessToken, getRefreshToken, getStoredEmployee, setTokens } from '../../auth/session';
import { ApiError } from '../errors';
import type {
  AttendanceRecord,
  EmployeePublic,
  LeaveBalanceRow,
  LeaveRow,
  LoginResult,
  MonthlySummary,
  PersonalReport,
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

// Synthetic preview rows only (no real people or data). Wide roles see the whole synthetic unit, others only themselves.
const DAILY_PEOPLE: [string, string, string, number][] = [
  ['S001', 'สมชาย ตัวอย่าง', '08:12', 0],
  ['S002', 'สมหญิง ทดสอบ', '08:41', 11],
  ['S003', 'วิชัย สมมติ', '08:30', 0],
  ['S004', 'อรทัย จำลอง', '08:55', 25],
  ['S005', 'ประเสริฐ ตัวอย่าง', '08:20', 0],
  ['S006', 'มาลี ทดสอบ', '08:35', 5],
];

function syntheticDaily(date: string, uid: string | null): AttendanceRecord[] {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return [];
  return DAILY_PEOPLE.map(([id, name, time, late], i) => {
    const [h, m] = time.split(':').map(Number);
    return {
      employeeUid: uid ?? `00000000-0000-4000-8000-00000000000${i + 1}`,
      date,
      checkIn: new Date(`${date}T${String(h - 7).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`).toISOString(),
      checkOut: new Date(`${date}T09:${String(30 + i).padStart(2, '0')}:00.000Z`).toISOString(),
      status: late > 0 ? 'late' : 'present',
      isLate: late > 0,
      lateMinutes: late > 0 ? late : undefined,
      employeeId: id,
      employeeName: name,
    };
  });
}

async function handleAttendanceDaily(date: string): Promise<AttendanceRecord[]> {
  const auth = authFromSession();
  if (auth.role === 'executive' || auth.role === 'manager') return syntheticDaily(date, null);
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

async function handleLeaveList(query: string): Promise<LeaveRow[]> {
  const auth = authFromSession();
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const target = params.get('employeeUid') || auth.employeeUid;
  assertCanReadEmployee(auth, target);
  return fixtureLeave.filter((row) => row.employeeUid === target);
}

// ---------- Fiscal entitlement overview (review build): synthetic people only ----------
type EntRow = import('../types').EntitlementRow;
type EntCell = import('../types').EntitlementCell;
const entCell = (extra: Partial<EntCell>): EntCell => ({
  status: 'ok', source: 'computed', available: true, entitlementDays: null, carryoverDays: null, totalDays: null, usedDays: null,
  pendingDays: 0, remainingDays: null, usageComplete: true, missing: [], reasons: [], flags: [], ...extra,
});
const unknownCell = (missing: string[]): EntCell => entCell({ status: 'unknown', available: false, missing });
const excludedCell = (): EntCell => entCell({ status: 'out_of_scope', available: false });
const DIV_A = { code: 'DIV_RESEARCH', nameTh: 'กองบริหารงานวิจัย' };
const DIV_B = { code: 'DIV_OFFICE', nameTh: 'กองบริหารงานสำนักวิจัยฯ' };
const emptyProfile = { hireDate: null, continuousServiceStart: null, appointmentKind: null, eligibilityConfirmed: null, eligibilityReference: null };
const entRows: EntRow[] = [
  { employeeUid: 'e1', employeeId: 'S001', name: 'สมชาย ตัวอย่าง', employeeType: 'university', division: DIV_A, scope: 'in_policy', missing: [], profile: { ...emptyProfile, hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', appointmentKind: 'first' }, types: {
    sick: entCell({ entitlementDays: 60, totalDays: 60, usedDays: 3, remainingDays: 57 }),
    personal: entCell({ entitlementDays: 45, totalDays: 45, usedDays: 2, remainingDays: 43 }),
    vacation: entCell({ source: 'hr_verified', entitlementDays: 10, carryoverDays: 8, totalDays: 18, usedDays: 4, remainingDays: 14 }),
  } },
  { employeeUid: 'e2', employeeId: 'S002', name: 'สมหญิง ตัวอย่าง', employeeType: 'university', division: DIV_A, scope: 'in_policy', missing: ['hireDate'], profile: { ...emptyProfile }, types: {
    sick: entCell({ entitlementDays: 60, totalDays: 60, usedDays: 0, remainingDays: 60 }),
    personal: unknownCell(['hireDate']),
    vacation: unknownCell(['hireDate']),
  } },
  { employeeUid: 'e3', employeeId: 'S003', name: 'สมศรี ตัวอย่าง', employeeType: 'university', division: DIV_B, scope: 'in_policy', missing: ['vacationCarryoverDays'], profile: { ...emptyProfile, hireDate: '2019-06-01', continuousServiceStart: '2019-06-01', appointmentKind: 'first' }, types: {
    sick: entCell({ entitlementDays: 60, totalDays: 60, usedDays: 1, remainingDays: 59 }),
    personal: entCell({ entitlementDays: 45, totalDays: 45, usedDays: 0, remainingDays: 45 }),
    vacation: unknownCell(['vacationCarryoverDays']),
  } },
  { employeeUid: 'e4', employeeId: 'S004', name: 'สมปอง ตัวอย่าง', employeeType: 'department', division: DIV_B, scope: 'unconfirmed', missing: [], profile: { ...emptyProfile }, types: {
    sick: entCell({ status: 'needs_hr', available: false }), personal: entCell({ status: 'needs_hr', available: false }), vacation: entCell({ status: 'needs_hr', available: false }),
  } },
  { employeeUid: 'e5', employeeId: 'S005', name: 'สมใจ ตัวอย่าง', employeeType: 'university', division: DIV_B, scope: 'in_policy', missing: [], profile: { ...emptyProfile, hireDate: '2012-01-01', continuousServiceStart: '2012-01-01', appointmentKind: 'first' }, types: {
    sick: entCell({ entitlementDays: 60, totalDays: 60, usedDays: 5, remainingDays: null, available: false, usageComplete: false }),
    personal: entCell({ entitlementDays: 45, totalDays: 45, usedDays: 0, remainingDays: null, available: false, usageComplete: false }),
    vacation: entCell({ entitlementDays: 10, carryoverDays: 5, totalDays: 15, usedDays: 2, remainingDays: null, available: false, usageComplete: false }),
  } },
  { employeeUid: 'e6', employeeId: 'S006', name: 'จ้างเหมา ตัวอย่าง', employeeType: 'contract', division: DIV_A, scope: 'excluded', missing: [], profile: { ...emptyProfile }, types: { sick: excludedCell(), personal: excludedCell(), vacation: excludedCell() } },
];

function handleEntitlements(role: string, year: number, division: string): import('../types').EntitlementOverview {
  if (!['executive', 'manager'].includes(role)) throw new ApiError(403, 'FORBIDDEN', 'The organisation overview needs an executive or manager role');
  if (!Number.isInteger(year) || year < 2569 || year > 2700) throw new ApiError(400, 'VALIDATION_ERROR', 'a fiscal year is a Buddhist-era year such as 2570');
  const rows = entRows.filter((r) => !division || r.division.code === division).map((r) => (role === 'executive' ? r : { ...r, profile: undefined }));
  const kinds = ['sick', 'personal', 'vacation'] as const;
  const byType = Object.fromEntries(kinds.map((t) => {
    const cells = rows.map((r) => r.types[t]).filter((c): c is EntCell => Boolean(c));
    const ok = cells.filter((c) => c.available && c.remainingDays !== null);
    const byStatus: Record<string, number> = {};
    for (const c of cells) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    return [t, {
      label: t, byStatus, determined: ok.length,
      entitlementDays: ok.reduce((n, c) => n + (c.totalDays ?? 0), 0), usedDays: ok.reduce((n, c) => n + (c.usedDays ?? 0), 0), remainingDays: ok.reduce((n, c) => n + (c.remainingDays ?? 0), 0),
    }];
  })) as import('../types').EntitlementOverview['summary']['byType'];
  const missing: Record<string, number> = {};
  for (const r of rows) if (r.scope !== 'excluded') for (const m of r.missing) missing[m] = (missing[m] || 0) + 1;
  return {
    fiscalYear: { be: year, start: `${year - 544}-10-01`, end: `${year - 543}-09-30` }, flag: 'on', canEdit: role === 'executive',
    types: [{ type: 'sick', labelTh: 'ลาป่วย' }, { type: 'personal', labelTh: 'ลากิจ' }, { type: 'vacation', labelTh: 'ลาพักผ่อน' }],
    divisions: [DIV_A, DIV_B],
    summary: {
      headcount: rows.length, inPolicy: rows.filter((r) => r.scope === 'in_policy').length, excluded: rows.filter((r) => r.scope === 'excluded').length,
      unconfirmed: rows.filter((r) => r.scope === 'unconfirmed').length,
      fullyDetermined: rows.filter((r) => kinds.every((t) => r.types[t]?.available && r.types[t]?.remainingDays !== null)).length, byType, missing,
    },
    rows,
  };
}

function handleSaveEntitlementFacts(role: string, uid: string, body: import('../types').EntitlementFactsInput): { changed: number; rows: LeaveBalanceRow[] } {
  if (role !== 'executive') throw new ApiError(403, 'FORBIDDEN', 'Only an executive with an organization grant can enter leave data');
  const row = entRows.find((r) => r.employeeUid === uid);
  if (!row || !row.profile) throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  let changed = 0;
  if ('hireDate' in body) { row.profile.hireDate = body.hireDate ?? null; changed += 1; if (body.hireDate) row.missing = row.missing.filter((m) => m !== 'hireDate'); }
  if ('continuousServiceStart' in body) { row.profile.continuousServiceStart = body.continuousServiceStart ?? null; changed += 1; }
  if ('appointmentKind' in body) { row.profile.appointmentKind = body.appointmentKind ?? null; changed += 1; }
  if (body.eligibility) { row.profile.eligibilityConfirmed = body.eligibility.confirmed; changed += 1; if (body.eligibility.confirmed === true) row.scope = 'in_policy'; if (body.eligibility.confirmed === false) row.scope = 'excluded'; }
  changed += body.entitlements?.length ?? 0;
  return { changed, rows: [] };
}

/** Synthetic fiscal-basis rows (fixture build only). Mirrors the shape of the engine's rows; no real person or HR figure. */
function fiscalFixtureRows(employeeUid: string, year: number): LeaveBalanceRow[] {
  const fiscalYear = { be: year, start: `${year - 544}-10-01`, end: `${year - 543}-09-30` };
  const base = { employeeUid, year, basis: 'fiscal' as const, fiscalYear };
  return [
    { ...base, leaveType: 'vacation', typeLabel: 'ลาพักผ่อน', status: 'ok', reasons: [], entitlementDays: 10, carryoverDays: 5, totalDays: 15, usedDays: 4, pendingDays: 1, remainingDays: 11, available: true, unavailableReason: null, usageComplete: true, uncoveredMonths: [] },
    { ...base, leaveType: 'personal', typeLabel: 'ลากิจ', status: 'ok', reasons: ['usage_coverage_incomplete'], entitlementDays: 15, carryoverDays: null, totalDays: 15, usedDays: 2, pendingDays: 0, remainingDays: null, available: false, unavailableReason: 'deductions_not_tracked', usageComplete: false, uncoveredMonths: [`${year - 544}-12`] },
    { ...base, leaveType: 'sick', typeLabel: 'ลาป่วย', status: 'needs_hr', reasons: ['needs_hr'], entitlementDays: null, carryoverDays: null, totalDays: null, usedDays: 0, pendingDays: 0, remainingDays: null, available: false, unavailableReason: 'no_entitlement', usageComplete: true, uncoveredMonths: [] },
  ];
}

async function handleLeaveBalance(employeeUid: string, year: number, basis: 'calendar' | 'fiscal' = 'calendar'): Promise<LeaveBalanceRow[]> {
  const auth = authFromSession();
  if (basis === 'fiscal') {
    if (!Number.isInteger(year) || year < 2569 || year > 2700) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'a fiscal year is a Buddhist-era year such as 2570');
    }
    assertCanReadEmployee(auth, employeeUid);
    if (!findEmployeePublic(employeeUid)) throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
    return fiscalFixtureRows(employeeUid, year);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'year is invalid');
  }
  assertCanReadEmployee(auth, employeeUid);
  if (!findEmployeePublic(employeeUid)) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  return fixtureBalances.filter((row) => row.employeeUid === employeeUid && row.year === year);
}

const THAI_MONTHS = [
  '',
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

function thaiDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${THAI_MONTHS[month]} ${year + 543}`;
}

async function handlePersonalReport(search: string): Promise<PersonalReport> {
  const auth = authFromSession();
  const params = new URLSearchParams(search);
  if (params.get('employeeUid') && params.get('employeeUid') !== auth.employeeUid) {
    throw new ApiError(403, 'FORBIDDEN', 'This report is limited to your own record');
  }
  if (params.get('employeeId')) {
    throw new ApiError(403, 'FORBIDDEN', 'This report is limited to your own record');
  }
  const year = Number(params.get('year'));
  const month = Number(params.get('month'));
  const employee = findEmployeePublic(auth.employeeUid);
  if (!employee) {
    throw new ApiError(404, 'NOT_FOUND', 'Employee was not found');
  }
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const scans = fixtureAttendance
    .filter((row) => row.employeeUid === auth.employeeUid && row.date >= start && row.date <= end)
    .map((row) => ({
      date: row.date,
      dateLabel: thaiDate(row.date),
      // shortcut: this fixture has one scan at 08:35/16:30, upgrade if another row is added
      checkInLabel: row.checkIn ? '08:35' : 'ไม่มีเวลาเข้า',
      checkOutLabel: row.checkOut ? '16:30' : 'ไม่มีเวลาออก',
      statusLabel: row.status === 'late' ? 'สาย' : row.status,
      lateMinutes: row.lateMinutes ?? null,
    }));
  const summary = fixtureMonthly.find(
    (row) => row.employeeUid === auth.employeeUid && row.year === year && row.month === month,
  ) ?? null;
  const leaveRows = fixtureLeave
    .filter((row) => row.employeeUid === auth.employeeUid && row.startDate <= end && row.endDate >= start)
    .map((row) => ({
      typeLabel: row.leaveType === 'personal' ? 'ลากิจ' : row.leaveType,
      startLabel: thaiDate(row.startDate),
      endLabel: thaiDate(row.endDate),
      statusLabel: row.status === 'approved' ? 'อนุมัติ' : row.status,
    }));
  const balances = fixtureBalances.filter((row) => row.employeeUid === auth.employeeUid && row.year === year);
  const empty = !summary && scans.length === 0 && leaveRows.length === 0;
  return {
    employeeUid: auth.employeeUid,
    employeeId: employee.employeeId,
    employeeName: `${employee.firstNameTh} ${employee.lastNameTh}`,
    department: employee.department,
    position: employee.position,
    year,
    month,
    buddhistYear: year + 543,
    periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`,
    empty,
    hasMonthlySummary: Boolean(summary),
    present: summary ? summary.totalPresent : null,
    late: summary ? summary.totalLate : null,
    absent: null,
    leaveDaysOnSummary: summary ? summary.totalLeave : null,
    leaveRecordedDays: 1.5,
    leaveNeedsReview: 0,
    workDays: summary ? summary.totalWorkDays : null,
    lateMinutes: summary ? summary.totalLateMinutes : null,
    scans: empty ? [] : scans,
    leaveRows: empty ? [] : leaveRows,
    leaveBalances: balances,
    remainingLeaveDays: balances.length ? balances.reduce((sum, row) => sum + (row.remainingDays ?? 0), 0) : null,
    source: 'stored-monthly-and-leave',
    notices: {
      holidaysApplied: false,
      holidayNote: 'จำนวนวันทำงานยังไม่หักวันหยุดนักขัตฤกษ์',
    },
  };
}

/** Review build only: synthetic people and numbers, so the page can be shown without any real record. */
function handleLeaveMonthly(role: string, year: number, month: number): import('../types').LeaveMonthlyReport {
  const wide = ['executive', 'manager', 'admin'].includes(role);
  const names = ['สมชาย ตัวอย่าง', 'สมหญิง ทดสอบ', 'วิชัย สมมติ', 'อรทัย จำลอง', 'ประเสริฐ ตัวอย่าง', 'มาลี ทดสอบ'];
  const { start, end } = { start: `${year}-${String(month).padStart(2, '0')}-01`, end: `${year}-${String(month).padStart(2, '0')}-28` };
  const rows = (wide ? names : names.slice(0, 1)).map((employeeName, index) => {
    const bucket = (requests: number, days: number) => ({ requests, days });
    const details = index === 1
      ? [{ leaveType: 'sick', typeLabel: 'ลาป่วย', startLabel: '30 เมษายน 2569', endLabel: '2 พฤษภาคม 2569', status: 'approved', statusLabel: 'อนุมัติ', daysInMonth: 2, crossesMonth: true, counted: true }]
      : index === 2
        ? [{ leaveType: 'personal', typeLabel: 'ลากิจ', startLabel: '10 พฤษภาคม 2569', endLabel: '10 พฤษภาคม 2569', status: 'pending', statusLabel: 'รออนุมัติ', daysInMonth: 1, crossesMonth: false, counted: false }]
        : [];
    return {
      employeeUid: `uid-${index + 1}`,
      divisionCode: 'DIV_OFFICE',
      divisionName: 'กองตัวอย่าง',
      recordedTotals: { records: 0, recordedDays: 0, approvedDays: 0, awaitingApprovalDays: 0, needsReviewRecords: 0, rejectedRecords: 0 },
      employeeId: `S${String(index + 1).padStart(3, '0')}`,
      employeeName,
      recorded: { personal: { approvedDays: 0, awaitingApprovalDays: 0, days: index === 3 ? 1.5 : 0, records: index === 3 ? 2 : 0, fullDays: index === 3 ? 1 : 0, halfDays: index === 3 ? 1 : 0 }, sick: { approvedDays: 0, awaitingApprovalDays: 0, days: index === 1 ? 0.5 : 0, records: index === 1 ? 1 : 0, fullDays: 0, halfDays: index === 1 ? 1 : 0 }, vacation: { approvedDays: 0, awaitingApprovalDays: 0, days: index === 4 ? 3 : 0, records: index === 4 ? 1 : 0, fullDays: index === 4 ? 3 : 0, halfDays: 0 } },
      recordedNeedsReview: index === 2 ? 1 : 0,
      recordedDetails: index === 1
        ? [{ date: '2026-05-04', dateLabel: '4 พฤษภาคม 2569', leaveType: 'sick', typeLabel: 'ลาป่วย', dayPart: 'AM' as const, partLabel: 'ครึ่งวันเช้า', dayFraction: 0.5, reviewStatus: 'candidate' as const, reasonLabels: [], approvalStatus: 'unverified' }]
        : index === 2
          ? [{ date: '2026-05-06', dateLabel: '6 พฤษภาคม 2569', leaveType: 'personal', typeLabel: 'ลากิจ', dayPart: 'UNKNOWN' as const, partLabel: 'ไม่ทราบช่วงเวลา', dayFraction: null, reviewStatus: 'needs_review' as const, reasonLabels: ['มีหมายเหตุลา แต่มีเวลาสแกนทั้งเข้าและออก'], approvalStatus: 'unverified' }]
          : [],
      hasLeaveData: true,
      byType: { personal: bucket(index === 3 ? 1 : 0, index === 3 ? 2 : 0), sick: bucket(index === 1 ? 1 : 0, index === 1 ? 2 : 0), vacation: bucket(index === 4 ? 1 : 0, index === 4 ? 3 : 0) },
      pendingRequests: index === 2 ? 1 : 0,
      rejectedRequests: 0,
      details,
    };
  });
  const sum = (k: 'personal' | 'sick' | 'vacation') => ({
    requests: rows.reduce((t, r) => t + (r.byType?.[k].requests ?? 0), 0),
    days: rows.reduce((t, r) => t + (r.byType?.[k].days ?? 0), 0),
  });
  return {
    scope: wide ? 'organization' : 'self',
    year,
    month,
    buddhistYear: year + 543,
    periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`,
    types: [{ type: 'personal', labelTh: 'ลากิจ' }, { type: 'sick', labelTh: 'ลาป่วย' }, { type: 'vacation', labelTh: 'ลาพักผ่อน' }],
    from: start,
    to: end,
    divisions: [{ code: 'DIV_OFFICE', nameTh: 'กองตัวอย่าง' }],
    statuses: [{ code: 'approved', label: 'อนุมัติแล้ว' }, { code: 'unverified', label: 'บันทึกจาก HIP · รออนุมัติ' }, { code: 'needs_review', label: 'รอตรวจสอบ' }, { code: 'rejected', label: 'ไม่อนุมัติ' }],
    filters: { division: null, employeeUid: null, status: null, type: null, divisionName: null, statusLabel: null, typeLabel: null, active: false },
    byDivision: null,
    records: [],
    reconciliation: { recordsMatched: 0, recordsInRows: 0, recordsInList: 0, recordsInDivisions: 0, recordedDaysInDivisions: 0, recordedDaysInTotals: 0, reconciled: true },
    recordedCoverage: { periodCovered: true, coveredMonths: [], uncoveredMonths: [], note: null },
    recordedTotals: { byType: { personal: { approvedDays: 0, awaitingApprovalDays: 0, days: 1.5, records: 2, fullDays: 1, halfDays: 1 }, sick: { approvedDays: 0, awaitingApprovalDays: 0, days: 0.5, records: 1, fullDays: 0, halfDays: 1 }, vacation: { approvedDays: 0, awaitingApprovalDays: 0, days: 3, records: 1, fullDays: 3, halfDays: 0 } }, needsReviewRecords: 1, all: { records: 1, recordedDays: 5, approvedDays: 0, awaitingApprovalDays: 5, needsReviewRecords: 1, rejectedRecords: 0 } },
    coverage: { leaveRecordsInSystem: 0, hasLeaveData: false, unmatchedRecordsExcluded: 0, note: 'ยังไม่มีข้อมูลการลาในระบบ' },
    totals: null,
    rows,
    notices: { dayCounting: 'ข้อมูลตัวอย่างสำหรับตรวจสอบหน้าจอเท่านั้น', recorded: 'ข้อมูลตัวอย่างสำหรับตรวจสอบหน้าจอเท่านั้น — ไม่ใช่หลักฐานการอนุมัติ', recordedCounting: 'ข้อมูลตัวอย่าง' },
  };
}

const reviewState: Record<string, 'approved' | 'rejected'> = {};
function handleLeaveReview(filter: string, year: number, month: number): import('../types').LeaveReviewList {
  const base = [
    { recordUid: 'r1', employeeId: 'S002', employeeName: 'สมหญิง ทดสอบ', date: `${year}-${String(month).padStart(2, '0')}-04`, dateLabel: '4 ตัวอย่าง', leaveType: 'sick', typeLabel: 'ลาป่วย', dayPart: 'AM' as const, partLabel: 'ครึ่งวันเช้า', dayFraction: 0.5, bucket: 'unverified' as const, approvalStatus: 'unverified', approvalLabel: 'ยังไม่ยืนยันอนุมัติ', reasonLabels: [], source: 'hip' as const, reviewedAt: null, reviewNote: null },
    { recordUid: 'r2', employeeId: 'S003', employeeName: 'วิชัย สมมติ', date: `${year}-${String(month).padStart(2, '0')}-06`, dateLabel: '6 ตัวอย่าง', leaveType: 'personal', typeLabel: 'ลากิจ', dayPart: 'UNKNOWN' as const, partLabel: 'ไม่ทราบช่วงเวลา', dayFraction: null, bucket: 'needs_review' as const, approvalStatus: 'unverified', approvalLabel: 'ยังไม่ยืนยันอนุมัติ', reasonLabels: ['มีหมายเหตุลา แต่มีเวลาสแกนทั้งเข้าและออก'], source: 'hip' as const, reviewedAt: null, reviewNote: null },
  ].map((row) => (reviewState[row.recordUid] ? { ...row, bucket: reviewState[row.recordUid], approvalStatus: reviewState[row.recordUid] } : row));
  const counts = { needs_review: 0, unverified: 0, approved: 0, rejected: 0 };
  for (const row of base) counts[row.bucket] += 1;
  return { year, month, buddhistYear: year + 543, periodLabel: 'ข้อมูลตัวอย่าง', filter: filter as import('../types').ReviewBucket, counts, rows: base.filter((row) => filter === 'all' || row.bucket === filter) };
}

function handleDivisions(role: string, year: number, month: number): import('../types').DivisionReport {
  const org = handleOrganizationReport(role, year, month);
  const bucket = (rows: import('../types').OrganizationReportRow[]): import('../types').DivisionBucket => {
    const withData = rows.filter((r) => r.hasMonthlySummary);
    const sum = (k: 'present' | 'late' | 'lateMinutes' | 'leaveDaysOnSummary' | 'leaveRecordedDays') => withData.reduce((t, r) => t + (r[k] ?? 0), 0);
    return {
      headcount: rows.length, withData: withData.length, withoutData: rows.length - withData.length,
      present: sum('present'), late: sum('late'), lateMinutes: sum('lateMinutes'), leaveDaysOnSummary: sum('leaveDaysOnSummary'), leaveRecordedDays: sum('leaveRecordedDays'), leaveNeedsReview: 0,
      avgPresentPerPerson: withData.length ? Math.round((sum('present') / withData.length) * 10) / 10 : null,
    };
  };
  const names = ['กองบริหารงานสำนักวิจัยฯ', 'กองบริหารงานวิจัย', 'กองบริหารงานบริการวิชาการ'];
  const codes = ['DIV_OFFICE', 'DIV_RESEARCH', 'DIV_ACADEMIC_SERVICE'];
  const slices = [org.rows.slice(0, 4), org.rows.slice(4, 8), org.rows.slice(8, 11)];
  const unassigned = org.rows.slice(11);
  return {
    scope: org.scope, recordedLeaveCovered: true, year, month, buddhistYear: org.buddhistYear, periodLabel: org.periodLabel, totals: org.totals,
    divisions: slices.map((rows, i) => ({ code: codes[i], nameTh: names[i], rows, ...bucket(rows) })),
    unassigned: { ...bucket(unassigned), rows: unassigned },
    ambiguous: { ...bucket([]), rows: [] },
    reconciliation: { employeesInScope: org.rows.length, assignedToDivisions: 11, unassigned: unassigned.length, ambiguous: 0, reconciled: true },
    notices: { holidayNote: org.notices.holidayNote, membershipNote: 'ข้อมูลตัวอย่างสำหรับตรวจสอบหน้าจอเท่านั้น' },
  };
}

function handleOrganizationReport(role: string, year: number, month: number): import('../types').OrganizationReport {
  if (!['executive', 'manager', 'admin'].includes(role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Organization reports need an executive or manager scope');
  }
  const names = ['สมชาย ตัวอย่าง', 'สมหญิง ทดสอบ', 'วิชัย สมมติ', 'อรทัย จำลอง', 'ประเสริฐ ตัวอย่าง', 'มาลี ทดสอบ',
    'ธนากร สมมติ', 'ชนิดา จำลอง', 'สุรชัย ตัวอย่าง', 'นภา ทดสอบ', 'กิตติ สมมติ', 'พิมพ์ใจ จำลอง'];
  const rows = names.map((employeeName, index) => {
    const hasMonthlySummary = index !== 10;
    return {
      employeeId: `S${String(index + 1).padStart(3, '0')}`,
      employeeName,
      department: 'หน่วยงานตัวอย่าง',
      hasMonthlySummary,
      workDays: hasMonthlySummary ? 22 : null,
      present: hasMonthlySummary ? 22 - (index % 3) : null,
      late: hasMonthlySummary ? (index * 2) % 7 : null,
      lateMinutes: hasMonthlySummary ? ((index * 2) % 7) * 11 : null,
      leaveDaysOnSummary: hasMonthlySummary ? index % 2 : null,
      leaveRecordedDays: hasMonthlySummary ? (index % 3) * 0.5 : null,
      leaveNeedsReview: hasMonthlySummary ? 0 : null,
      absent: null,
    };
  });
  const withData = rows.filter((row) => row.hasMonthlySummary);
  const sum = (key: 'present' | 'late' | 'lateMinutes' | 'leaveDaysOnSummary') =>
    withData.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  return {
    scope: 'organization',
    year,
    month,
    buddhistYear: year + 543,
    periodLabel: `${thaiDate(`${year}-${String(month).padStart(2, '0')}-01`)} (ข้อมูลตัวอย่าง)`,
    totals: {
      employeesInScope: rows.length,
      employeesWithData: withData.length,
      employeesWithoutData: rows.length - withData.length,
      present: sum('present'),
      late: sum('late'),
      lateMinutes: sum('lateMinutes'),
      leaveDaysOnSummary: sum('leaveDaysOnSummary'),
      leaveRecordedDays: rows.reduce((t, r) => t + (r.leaveRecordedDays ?? 0), 0),
      leaveNeedsReview: 0,
      absent: null,
    },
    rows,
    notices: {
      holidaysApplied: false,
      holidayNote: 'จำนวนวันทำงานยังไม่หักวันหยุดนักขัตฤกษ์',
    },
  };
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

  if (auth && method === 'GET' && (path === '/auth/me' || path === '/auth/sso/me')) {
    return (await handleMe()) as T;
  }

  if (auth && method === 'POST' && (path === '/auth/logout' || path === '/auth/sso/logout')) {
    return (await handleLogout(options.body)) as T;
  }

  const dailyMatch = path.match(/^\/attendance\/daily\/(\d{4}-\d{2}-\d{2})$/);
  if (auth && method === 'GET' && dailyMatch) {
    return (await handleAttendanceDaily(dailyMatch[1])) as T;
  }

  const meMatch = path.match(/^\/attendance\/me\/(\d{4}-\d{2}-\d{2})$/);
  if (auth && method === 'GET' && meMatch) {
    const own = authFromSession();
    return syntheticDaily(meMatch[1], own.employeeUid).slice(1, 2).map((row) => ({ ...row, employeeId: 'E-USER', employeeName: 'ผู้ใช้ ตัวอย่าง' })) as T;
  }

  const monthlyMatch = path.match(/^\/attendance\/monthly\/([^/]+)\/(\d+)\/(\d+)$/);
  if (auth && method === 'GET' && monthlyMatch) {
    return (await handleAttendanceMonthly(
      decodeURIComponent(monthlyMatch[1]),
      Number(monthlyMatch[2]),
      Number(monthlyMatch[3]),
    )) as T;
  }

  const ownAttendance = path.match(/^\/employees\/([^/]+)\/attendance$/);
  if (auth && method === 'GET' && ownAttendance) {
    const target = decodeURIComponent(ownAttendance[1]);
    assertCanReadEmployee(authFromSession(), target);
    return fixtureAttendance.filter((row) => row.employeeUid === target) as T;
  }

  const leaveListMatch = path.match(/^\/leave(\?.*)?$/);
  if (auth && method === 'GET' && leaveListMatch) {
    const query = leaveListMatch[1] ?? '';
    return (await handleLeaveList(query)) as T;
  }

  const balanceMatch = path.match(/^\/leave\/balance\/([^/?]+)\?year=(\d+)(&basis=fiscal)?$/);
  if (auth && method === 'GET' && balanceMatch) {
    return (await handleLeaveBalance(decodeURIComponent(balanceMatch[1]), Number(balanceMatch[2]), balanceMatch[3] ? 'fiscal' : 'calendar')) as T;
  }

  const leaveMonthlyMatch = path.match(/^\/reports\/leave-monthly\?year=(\d+)&month=(\d+)/);
  if (auth && method === 'GET' && leaveMonthlyMatch) {
    return handleLeaveMonthly(authFromSession().role, Number(leaveMonthlyMatch[1]), Number(leaveMonthlyMatch[2])) as T;
  }

  const entMatch = path.match(/^\/leave\/entitlements\?year=(\d+)(?:&division=([\w%]+))?$/);
  if (auth && method === 'GET' && entMatch) {
    return handleEntitlements(authFromSession().role, Number(entMatch[1]), decodeURIComponent(entMatch[2] ?? '')) as T;
  }
  const entSaveMatch = path.match(/^\/leave\/entitlements\/([^/?]+)\?year=(\d+)$/);
  if (auth && method === 'PUT' && entSaveMatch) {
    return handleSaveEntitlementFacts(authFromSession().role, decodeURIComponent(entSaveMatch[1]), options.body as import('../types').EntitlementFactsInput) as T;
  }

  const reviewMatch = path.match(/^\/leave-review\?year=(\d+)&month=(\d+)&filter=(\w+)$/);
  if (auth && method === 'GET' && reviewMatch) {
    if (authFromSession().role !== 'executive') throw new ApiError(403, 'FORBIDDEN', 'Only an executive with an organization grant can review leave');
    return handleLeaveReview(reviewMatch[3], Number(reviewMatch[1]), Number(reviewMatch[2])) as T;
  }
  if (auth && method === 'POST' && path === '/leave-review/decisions') {
    const decisions = (options.body as { decisions: { recordUid: string; action: string }[] }).decisions;
    for (const d of decisions) reviewState[d.recordUid] = d.action === 'approve' ? 'approved' : 'rejected';
    return { applied: decisions.length, failed: 0, results: decisions.map((d) => ({ recordUid: d.recordUid, ok: true })) } as T;
  }

  const divMatch = path.match(/^\/reports\/divisions\?year=(\d+)&month=(\d+)$/);
  if (auth && method === 'GET' && divMatch) {
    return handleDivisions(authFromSession().role, Number(divMatch[1]), Number(divMatch[2])) as T;
  }

  const orgMatch = path.match(/^\/reports\/organization\?year=(\d+)&month=(\d+)$/);
  if (auth && method === 'GET' && orgMatch) {
    return handleOrganizationReport(authFromSession().role, Number(orgMatch[1]), Number(orgMatch[2])) as T;
  }

  const reportMatch = path.match(/^\/reports\/personal\?(.+)$/);
  if (auth && method === 'GET' && reportMatch) {
    return (await handlePersonalReport(reportMatch[1])) as T;
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
