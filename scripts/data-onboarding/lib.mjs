/**
 * Synthetic-only onboarding helpers. These modules never open a database
 * and never read production credentials.
 */
import { createHash } from 'node:crypto';

export const TOOL_VERSION = '0.1.0';

export const SECRET_FIELDS = new Set([
  'password_hash',
  'password',
  'token',
  'refresh_token',
  'access_token',
  'client_secret',
  'national_id_encrypted',
  'raw_data',
  'raw_row_json',
]);

export const LEAVE_TYPES = new Set(['sick', 'personal', 'vacation', 'other']);
export const BALANCE_TYPES = new Set(['sick', 'personal', 'vacation', 'maternity', 'paternity', 'study']);
export const EMPLOYEE_TYPES = new Set(['university', 'department', 'contract']);
export const EMPLOYEE_STATUSES = new Set(['active', 'inactive', 'resigned']);
export const ATTENDANCE_STATUSES = new Set(['present', 'late', 'absent', 'leave', 'holiday']);
export const ID_TYPES = new Set(['facescan_id', 'national_id', 'employee_id']);
export const ACCESS_ROLES = new Set(['EXECUTIVE', 'MANAGER', 'EMPLOYEE', 'ADMIN']);
export const SCOPE_TYPES = new Set(['self', 'org_unit', 'organization']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function stableEmployeeUid(employeeId) {
  const hash = createHash('sha256').update(`rae-attendance-v2:employee:${employeeId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function asArray(bundle, key) {
  const value = bundle[key];
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value;
}

export function inspectSource(bundle) {
  const sections = [
    'employees',
    'employee_identifier',
    'daily_attendance',
    'monthly_summary',
    'staging_leave',
    'leave_balance',
    'authorization_grants',
    'employee_org_membership',
  ];
  const tables = {};
  for (const name of sections) {
    const rows = asArray(bundle, name);
    const fields = new Set();
    const secretFields = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const key of Object.keys(row)) {
        fields.add(key);
        if (SECRET_FIELDS.has(key)) secretFields.add(key);
      }
    }
    tables[name] = {
      rows: rows.length,
      fields: [...fields].sort(),
      secretFields: [...secretFields].sort(),
    };
  }
  return {
    tool: TOOL_VERSION,
    manifest: bundle.manifest ?? null,
    tables,
  };
}

function issue(errors, table, index, code, message) {
  errors.push({ table, index, code, message });
}

export function validateSource(bundle) {
  const errors = [];
  const employees = asArray(bundle, 'employees');
  const identifiers = asArray(bundle, 'employee_identifier');
  const attendance = asArray(bundle, 'daily_attendance');
  const monthly = asArray(bundle, 'monthly_summary');
  const leave = asArray(bundle, 'staging_leave');
  const balances = asArray(bundle, 'leave_balance');
  const grants = asArray(bundle, 'authorization_grants');
  const memberships = asArray(bundle, 'employee_org_membership');

  const employeeIds = new Map();
  const emails = new Map();

  employees.forEach((row, index) => {
    const employeeId = row?.employee_id;
    const email = typeof row?.email === 'string' ? row.email.toLowerCase() : '';
    if (!employeeId) issue(errors, 'employees', index, 'REQUIRED', 'employee_id is required');
    else if (employeeIds.has(employeeId)) {
      issue(errors, 'employees', index, 'DUPLICATE_EMPLOYEE_ID', `duplicate employee_id ${employeeId}`);
    } else employeeIds.set(employeeId, index);
    if (!email) issue(errors, 'employees', index, 'REQUIRED', 'email is required');
    else if (emails.has(email)) issue(errors, 'employees', index, 'DUPLICATE_EMAIL', `duplicate email ${email}`);
    else emails.set(email, index);
    if (!row?.first_name_th) issue(errors, 'employees', index, 'REQUIRED', 'first_name_th is required');
    if (!row?.last_name_th) issue(errors, 'employees', index, 'REQUIRED', 'last_name_th is required');
    if (!row?.department) issue(errors, 'employees', index, 'REQUIRED', 'department is required');
    if (!EMPLOYEE_TYPES.has(row?.employee_type)) {
      issue(errors, 'employees', index, 'INVALID_ENUM', 'employee_type is not a V2 enum');
    }
    if (!EMPLOYEE_STATUSES.has(row?.status)) {
      issue(errors, 'employees', index, 'INVALID_ENUM', 'status is not a V2 enum');
    }
    if (row?.hire_date != null && !isIsoDate(row.hire_date)) {
      issue(errors, 'employees', index, 'INVALID_DATE', 'hire_date is not YYYY-MM-DD');
    }
    if (SECRET_FIELDS.has('password_hash') && row?.password_hash) {
      issue(errors, 'employees', index, 'SECRET_PRESENT', 'password_hash must not be imported');
    }
  });

  const knownIds = new Set(employeeIds.keys());

  identifiers.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id) && !row?.employee_uid) {
      issue(errors, 'employee_identifier', index, 'UNKNOWN_EMPLOYEE', 'identifier does not map to an employee');
    }
    if (!ID_TYPES.has(row?.id_type)) issue(errors, 'employee_identifier', index, 'INVALID_ENUM', 'id_type is invalid');
    if (row?.id_type === 'national_id') {
      issue(errors, 'employee_identifier', index, 'SENSITIVE_ID', 'national_id values are out of scope for this importer');
    }
    if (!row?.id_value) issue(errors, 'employee_identifier', index, 'REQUIRED', 'id_value is required');
  });

  const identKeys = new Set();
  identifiers.forEach((row, index) => {
    if (!row?.id_type || !row?.id_value) return;
    const key = `${row.id_type}:${row.id_value}`;
    if (identKeys.has(key)) issue(errors, 'employee_identifier', index, 'DUPLICATE_IDENTIFIER', `duplicate ${key}`);
    identKeys.add(key);
  });

  const attendanceKeys = new Set();
  attendance.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id)) {
      issue(errors, 'daily_attendance', index, 'ORPHAN_ATTENDANCE', 'attendance employee_id is unknown');
    }
    if (!isIsoDate(row?.date)) issue(errors, 'daily_attendance', index, 'INVALID_DATE', 'date is not YYYY-MM-DD');
    if (!ATTENDANCE_STATUSES.has(row?.status)) {
      issue(errors, 'daily_attendance', index, 'INVALID_ENUM', 'attendance status is invalid');
    }
    if (row?.check_in && row?.check_out && row.check_out < row.check_in) {
      issue(errors, 'daily_attendance', index, 'INVALID_RANGE', 'check_out is before check_in');
    }
    const key = `${row?.employee_id}|${row?.date}`;
    if (row?.employee_id && row?.date) {
      if (attendanceKeys.has(key)) issue(errors, 'daily_attendance', index, 'OVERLAP', `duplicate day ${key}`);
      attendanceKeys.add(key);
    }
  });

  const monthKeys = new Set();
  monthly.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id)) {
      issue(errors, 'monthly_summary', index, 'UNKNOWN_EMPLOYEE', 'monthly row employee_id is unknown');
    }
    const month = Number(row?.month);
    const year = Number(row?.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      issue(errors, 'monthly_summary', index, 'INVALID_DATE', 'year is out of range');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      issue(errors, 'monthly_summary', index, 'INVALID_DATE', 'month is out of range');
    }
    const key = `${row?.employee_id}|${year}|${month}`;
    if (monthKeys.has(key)) issue(errors, 'monthly_summary', index, 'DUPLICATE', `duplicate month ${key}`);
    monthKeys.add(key);
  });

  const leaveByEmployee = new Map();
  leave.forEach((row, index) => {
    if (row?.national_id_encrypted || row?.raw_data) {
      issue(errors, 'staging_leave', index, 'SECRET_PRESENT', 'sensitive leave columns must be omitted');
    }
    if (!knownIds.has(row?.employee_id) && !row?.employee_uid) {
      issue(errors, 'staging_leave', index, 'UNKNOWN_EMPLOYEE', 'leave row does not map to an employee');
    }
    if (!isIsoDate(row?.start_date) || !isIsoDate(row?.end_date)) {
      issue(errors, 'staging_leave', index, 'INVALID_DATE', 'leave dates are invalid');
    } else if (row.end_date < row.start_date) {
      issue(errors, 'staging_leave', index, 'INVALID_RANGE', 'leave end_date is before start_date');
    }
    if (row?.leave_type && !LEAVE_TYPES.has(row.leave_type)) {
      issue(errors, 'staging_leave', index, 'INVALID_ENUM', 'leave_type is not a V2 employee_leave enum');
    }
    if (!row?.leave_id) issue(errors, 'staging_leave', index, 'REQUIRED', 'leave_id is required');
    const owner = row?.employee_id || row?.employee_uid;
    if (owner && isIsoDate(row?.start_date) && isIsoDate(row?.end_date)) {
      const list = leaveByEmployee.get(owner) ?? [];
      for (const prior of list) {
        if (rangesOverlap(prior.start, prior.end, row.start_date, row.end_date)) {
          issue(errors, 'staging_leave', index, 'OVERLAP', `leave overlaps another row for ${owner}`);
          break;
        }
      }
      list.push({ start: row.start_date, end: row.end_date });
      leaveByEmployee.set(owner, list);
    }
  });

  balances.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id)) {
      issue(errors, 'leave_balance', index, 'UNKNOWN_EMPLOYEE', 'balance employee_id is unknown');
    }
    if (!BALANCE_TYPES.has(row?.leave_type)) {
      issue(errors, 'leave_balance', index, 'INVALID_ENUM', 'balance leave_type is invalid');
    }
    const total = Number(row?.total_days);
    const used = Number(row?.used_days);
    const remaining = Number(row?.remaining_days);
    if ([total, used, remaining].some((n) => Number.isNaN(n))) {
      issue(errors, 'leave_balance', index, 'REQUIRED', 'balance day fields must be numeric');
    } else if (Math.abs(total - used - remaining) > 0.001) {
      issue(errors, 'leave_balance', index, 'BALANCE_MISMATCH', 'remaining_days must equal total_days - used_days');
    }
  });

  grants.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id)) {
      issue(errors, 'authorization_grants', index, 'UNKNOWN_EMPLOYEE', 'grant employee_id is unknown');
    }
    if (!ACCESS_ROLES.has(row?.role)) {
      issue(errors, 'authorization_grants', index, 'INVALID_ENUM', 'role must be EXECUTIVE, MANAGER, EMPLOYEE, or ADMIN');
    }
    if (!SCOPE_TYPES.has(row?.scope_type)) {
      issue(errors, 'authorization_grants', index, 'INVALID_ENUM', 'scope_type is invalid');
    }
    if (row?.scope_type === 'org_unit' && !row?.org_unit_code) {
      issue(errors, 'authorization_grants', index, 'REQUIRED', 'org_unit scope requires an org_unit_code');
    }
    if (row?.scope_type === 'organization' && row?.org_unit_code) {
      issue(errors, 'authorization_grants', index, 'HIERARCHY_UNKNOWN', 'organization scope must not invent an org unit');
    }
    if (row?.role === 'MANAGER' && row?.scope_type === 'organization') {
      issue(errors, 'authorization_grants', index, 'HIERARCHY_UNKNOWN', 'manager organization-wide scope is not defined');
    }
  });

  memberships.forEach((row, index) => {
    if (!knownIds.has(row?.employee_id)) {
      issue(errors, 'employee_org_membership', index, 'UNKNOWN_EMPLOYEE', 'membership employee_id is unknown');
    }
    if (!row?.org_unit_code) {
      issue(errors, 'employee_org_membership', index, 'REQUIRED', 'org_unit_code is required');
    }
  });

  return { ok: errors.length === 0, errors };
}

function uidFor(row, employeesById) {
  if (row.employee_uid) return row.employee_uid;
  const employee = employeesById.get(row.employee_id);
  return employee?.employee_uid;
}

export function transformSource(bundle) {
  const now = '1970-01-01 00:00:00';
  const employees = asArray(bundle, 'employees').map((row) => {
    const employeeUid = row.employee_uid || stableEmployeeUid(row.employee_id);
    return {
      employee_uid: employeeUid,
      employee_id: row.employee_id,
      first_name_th: row.first_name_th,
      last_name_th: row.last_name_th,
      first_name_en: row.first_name_en ?? null,
      last_name_en: row.last_name_en ?? null,
      email: String(row.email).toLowerCase(),
      password_hash: null,
      last_login: null,
      login_attempts: null,
      locked_until: null,
      phone: row.phone ?? null,
      department: row.department,
      position: row.position ?? null,
      employee_type: row.employee_type,
      hire_date: row.hire_date ?? null,
      status: row.status,
      role: row.role ?? null,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    };
  });
  const employeesById = new Map(employees.map((row) => [row.employee_id, row]));

  const employeeIdentifier = asArray(bundle, 'employee_identifier')
    .filter((row) => row.id_type !== 'national_id')
    .map((row) => ({
      employee_uid: uidFor(row, employeesById),
      id_type: row.id_type,
      id_value: row.id_value,
      is_primary: row.is_primary ? 1 : 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    }));

  const dailyAttendance = asArray(bundle, 'daily_attendance').map((row) => ({
    employee_uid: uidFor(row, employeesById),
    date: row.date,
    check_in: row.check_in ?? null,
    check_out: row.check_out ?? null,
    is_late: row.is_late ? 1 : 0,
    late_minutes: row.late_minutes ?? 0,
    work_duration: row.work_duration ?? 0,
    is_leave: row.is_leave ? 1 : 0,
    leave_type: row.leave_type ?? null,
    status: row.status,
    notes: row.notes ?? null,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  const monthlySummary = asArray(bundle, 'monthly_summary').map((row) => ({
    employee_uid: uidFor(row, employeesById),
    year: Number(row.year),
    month: Number(row.month),
    total_work_days: row.total_work_days ?? 0,
    total_present: row.total_present ?? 0,
    total_late: row.total_late ?? 0,
    total_absent: row.total_absent ?? 0,
    total_leave: row.total_leave ?? 0,
    total_late_minutes: row.total_late_minutes ?? 0,
    total_work_hours: row.total_work_hours ?? 0,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  const employeeLeave = asArray(bundle, 'staging_leave').map((row) => ({
    leave_id: row.leave_id,
    employee_uid: uidFor(row, employeesById),
    leave_type: row.leave_type,
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status ?? 'approved',
    match_status: row.match_status ?? 'pending',
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  const authorizationGrants = asArray(bundle, 'authorization_grants').map((row) => ({
    employee_uid: uidFor(row, employeesById),
    role: row.role,
    scope_type: row.scope_type,
    org_unit_code: row.scope_type === 'org_unit' ? row.org_unit_code : null,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  const employeeOrgMembership = asArray(bundle, 'employee_org_membership').map((row) => ({
    employee_uid: uidFor(row, employeesById),
    org_unit_code: row.org_unit_code,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  const leaveBalance = asArray(bundle, 'leave_balance').map((row) => ({
    employee_uid: uidFor(row, employeesById),
    year: Number(row.year),
    leave_type: row.leave_type,
    total_days: Number(row.total_days),
    used_days: Number(row.used_days),
    remaining_days: Number(row.remaining_days),
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  }));

  return {
    employees,
    employee_identifier: employeeIdentifier,
    daily_attendance: dailyAttendance,
    monthly_summary: monthlySummary,
    employee_leave: employeeLeave,
    leave_balance: leaveBalance,
    authorization_grants: authorizationGrants,
    employee_org_membership: employeeOrgMembership,
    omitted: {
      refresh_tokens: 'create on login; do not copy legacy tokens',
      auth_logs: 'start empty; do not copy legacy auth events',
      system_logs: 'not imported',
      password_hash: 'forced null',
      national_id: 'dropped',
    },
  };
}

export function naturalKey(table, row) {
  switch (table) {
    case 'employees':
      return `employee_id:${row.employee_id}`;
    case 'employee_identifier':
      return `${row.id_type}:${row.id_value}`;
    case 'daily_attendance':
      return `${row.employee_uid}|${row.date}`;
    case 'monthly_summary':
      return `${row.employee_uid}|${row.year}|${row.month}`;
    case 'employee_leave':
      return `leave_id:${row.leave_id}`;
    case 'leave_balance':
      return `${row.employee_uid}|${row.year}|${row.leave_type}`;
    case 'authorization_grants':
      return `${row.employee_uid}|${row.role}|${row.scope_type}|${row.org_unit_code ?? ''}`;
    case 'employee_org_membership':
      return `${row.employee_uid}|${row.org_unit_code}`;
    default:
      return JSON.stringify(row);
  }
}

export function dryRun(bundle, { appliedKeys = [], sourceText = '' } = {}) {
  const validation = validateSource(bundle);
  const transformed = transformSource(bundle);
  const applied = new Set(appliedKeys);
  const plan = {};
  for (const [table, rows] of Object.entries(transformed)) {
    if (table === 'omitted') continue;
    const insert = [];
    const skip = [];
    for (const row of rows) {
      const key = naturalKey(table, row);
      if (applied.has(`${table}:${key}`)) skip.push(key);
      else insert.push(key);
    }
    plan[table] = { insert, skip, rows: rows.length };
  }
  const checksum = sha256Text(JSON.stringify(plan));
  return {
    tool: TOOL_VERSION,
    mode: 'dry-run',
    writesDatabase: false,
    manifest: bundle.manifest ?? null,
    sourceSha256: sourceText ? sha256Text(sourceText) : null,
    validation,
    plan,
    omitted: transformed.omitted,
    rollbackKeys: Object.entries(plan).flatMap(([table, entry]) => entry.insert.map((key) => `${table}:${key}`)),
    checksum,
  };
}

export function reconcile(report, expected) {
  const mismatches = [];
  for (const [table, exp] of Object.entries(expected.tables ?? {})) {
    const actual = report.plan?.[table]?.rows;
    if (actual !== exp.rows) {
      mismatches.push({ table, code: 'ROW_COUNT', expected: exp.rows, actual });
    }
  }
  if (expected.checksum && report.checksum !== expected.checksum) {
    mismatches.push({
      table: '*',
      code: 'CHECKSUM',
      expected: expected.checksum,
      actual: report.checksum,
    });
  }
  if (expected.requireValid && report.validation && !report.validation.ok) {
    mismatches.push({ table: '*', code: 'VALIDATION', expected: true, actual: false });
  }
  return { ok: mismatches.length === 0, mismatches };
}
