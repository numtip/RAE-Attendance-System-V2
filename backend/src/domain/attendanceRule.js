/**
 * Versioned attendance rules, the holiday calendar and per-employee schedules (migration 022).
 *
 * Why this exists: the donor project kept work hours, late/early thresholds and leave tokens in a
 * settings file and in Python defaults. Nothing was effective-dated or approved, so a past period could
 * not be recomputed reproducibly. Here the policy is data: a rule version carries its window, its approval
 * state and its policy token lists, and the engine may only compute with an `approved` row.
 *
 * Everything in this file is pure. No I/O, no database, no repository access. Validation runs before any
 * write so a bad row is rejected with a coded 400 instead of a raw CHECK-constraint or NOT NULL error.
 * Every validator message is value-free: the rejected value is never interpolated.
 */
const { HttpError } = require('../utils/httpError');
const { normalizeValidityDate, isEffectiveOnDate } = require('./identifierValidity');

const RULE_STATUS = Object.freeze(['draft', 'pending_approval', 'approved', 'retired']);
const SCHEDULE_STATUS = Object.freeze(['pending', 'approved', 'rejected']);
const HOLIDAY_STATUS = Object.freeze(['candidate', 'approved']);
const HOLIDAY_SCOPE = Object.freeze(['national', 'university', 'department']);
const COMPUTATION_STATUS = Object.freeze([
  'calculated',
  'no_data',
  'insufficient_data',
  'pending_policy',
  'failed',
]);
const DAY_CLASSIFICATION = Object.freeze(['workday', 'holiday', 'weekend']);
const DEFAULT_RULE_CODES = Object.freeze({ RULE: 'AR-0001' });

/** ISO-8601 day numbers (1=Monday .. 7=Sunday), matching attendance_schedule.work_days_json. */
const DEFAULT_WORK_DAYS = Object.freeze([1, 2, 3, 4, 5]);

/** The TIME columns shared by attendance_rule_version and attendance_schedule. */
const TIME_KEYS = Object.freeze(['workStart', 'workEnd', 'lateAfter', 'earlyBefore']);

const CODE_PATTERN = /^[A-Za-z0-9._-]+$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const TIME_MESSAGE = 'time must be HH:MM or HH:MM:SS';

// --- time ---------------------------------------------------------------------

/**
 * 'HH:MM' or 'HH:MM:SS' -> minutes after midnight (0..1439). Anything else throws RULE_INVALID_TIME.
 * The rejected value is never echoed: the message is static.
 */
function parseTimeToMinutes(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = TIME_PATTERN.exec(text);
  if (!match) {
    throw new HttpError(400, 'RULE_INVALID_TIME', TIME_MESSAGE);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new HttpError(400, 'RULE_INVALID_TIME', 'time must be a clock time between 00:00:00 and 23:59:59');
  }
  return (hours * 60) + minutes;
}

/** Minutes after midnight (0..1439) -> zero-padded 'HH:MM:SS'. Round-trips with parseTimeToMinutes. */
function minutesToTimeString(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new HttpError(400, 'RULE_INVALID_TIME', 'minutes must be an integer between 0 and 1439');
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}:00`;
}

// --- dates and windows --------------------------------------------------------

/**
 * Delegates to the shared validity-date parser so this feature cannot drift from the identifier and
 * assignment features (they once disagreed on a Date input: UTC vs local midnight). Only the error code
 * differs; the message stays value-free.
 */
function normalizeEffectiveDate(value, fieldName = 'date') {
  return normalizeDateWithCode(value, fieldName, 'RULE_INVALID_DATE');
}

function normalizeDateWithCode(value, fieldName, errorCode) {
  try {
    return normalizeValidityDate(value, fieldName);
  } catch (error) {
    if (error && error.code === 'IDENTIFIER_INVALID_EFFECTIVE_DATE') {
      throw new HttpError(400, errorCode, `${fieldName} must be an ISO date (YYYY-MM-DD)`);
    }
    throw error;
  }
}

/** Inclusive window check. `date == null` means "do not filter" (mirrors identifierValidity.isEffectiveOnDate). */
function isRuleEffectiveOn(rule, date) {
  if (date == null) return true;
  return isEffectiveOnDate(rule, normalizeEffectiveDate(date, 'date'));
}

/** Same semantics as isRuleEffectiveOn, kept separate so the two windows may diverge later. */
function isScheduleEffectiveOn(schedule, date) {
  if (date == null) return true;
  return isEffectiveOnDate(schedule, normalizeEffectiveDate(date, 'date'));
}

// --- policy tokens ------------------------------------------------------------

function readJsonValue(value) {
  if (typeof value !== 'string') return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value: null };
  }
}

function parseStringTokenList(raw, field, warnings) {
  if (raw == null || raw === '') return [];
  const parsed = readJsonValue(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    warnings.push(`${field} is not a readable JSON array`);
    return [];
  }
  return parsed.value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
}

function parseAliasTokenMap(raw, field, warnings) {
  if (raw == null || raw === '') return {};
  const parsed = readJsonValue(raw);
  const value = parsed.value;
  if (!parsed.ok || value === null || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${field} is not a readable JSON object`);
    return {};
  }
  return { ...value };
}

/**
 * Reads the three token columns. They may arrive as a parsed array/object (mysql2 parses JSON columns),
 * as a JSON string (fixture rows, or a driver with JSON parsing off) or as null. Malformed JSON never
 * throws: the collection comes back empty and the field is named in `warnings`, so the engine can report
 * "policy token list unreadable" instead of silently treating every remark as a work day.
 */
function parsePolicyTokens(rule) {
  const source = rule || {};
  const warnings = [];
  const leaveTypes = parseStringTokenList(source.leaveTypesJson, 'leave_types_json', warnings);
  const businessStatuses = parseStringTokenList(source.businessStatusesJson, 'business_statuses_json', warnings);
  const leaveAliases = parseAliasTokenMap(source.leaveAliasesJson, 'leave_aliases_json', warnings);
  return { leaveTypes, leaveAliases, businessStatuses, warnings };
}

// --- work days ----------------------------------------------------------------

/** ISO-8601 day number (1=Monday .. 7=Sunday) for a real 'YYYY-MM-DD' date; else RULE_INVALID_DATE. */
function isoDayNumber(isoDate) {
  const text = typeof isoDate === 'string' ? isoDate.trim() : '';
  const match = ISO_DATE_PATTERN.exec(text);
  if (!match) {
    throw new HttpError(400, 'RULE_INVALID_DATE', 'date must be an ISO date (YYYY-MM-DD)');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
  if (!real) {
    throw new HttpError(400, 'RULE_INVALID_DATE', 'date must be an ISO date (YYYY-MM-DD)');
  }
  const weekday = probe.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * Membership test using ISO-8601 day numbers. A missing or empty `workDays` falls back to the
 * Monday-to-Friday default rather than pretending the date is a work day or not.
 */
function isWorkDay(workDays, isoDate) {
  const days = Array.isArray(workDays) && workDays.length > 0 ? workDays : DEFAULT_WORK_DAYS;
  const target = isoDayNumber(isoDate);
  return days.some((day) => Number(day) === target);
}

// --- input normalization ------------------------------------------------------

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalText(value) {
  const text = trimmed(value);
  return text === '' ? null : text;
}

function normalizeCode(value, errorCode, fieldName, maxLength = 64) {
  const code = trimmed(value);
  const valid = code !== ''
    && code.length <= maxLength
    && CODE_PATTERN.test(code);
  if (!valid) {
    throw new HttpError(400, errorCode, `${fieldName} is required, at most ${maxLength} characters, letters/digits/dot/underscore/hyphen only`);
  }
  return code;
}

function normalizeName(value, errorCode, fieldName, maxLength = 255) {
  const name = trimmed(value);
  if (name === '' || name.length > maxLength) {
    throw new HttpError(400, errorCode, `${fieldName} is required and must be at most ${maxLength} characters`);
  }
  return name;
}

function normalizeStatus(value, allowed, errorCode, fieldName) {
  const status = trimmed(value);
  if (!allowed.includes(status)) {
    throw new HttpError(400, errorCode, `${fieldName} must be one of: ${allowed.join(', ')}`);
  }
  return status;
}

function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return Boolean(value);
}

/** Required TIME -> canonical 'HH:MM:SS'; rejects missing and malformed values with `errorCode`. */
function normalizeClock(value, fieldName, errorCode) {
  if (value === undefined || value === null || value === '') {
    throw new HttpError(400, errorCode, `${fieldName} is required`);
  }
  try {
    return minutesToTimeString(parseTimeToMinutes(value));
  } catch (error) {
    if (error && error.code === 'RULE_INVALID_TIME') {
      throw new HttpError(400, errorCode, `${fieldName} must be ${TIME_MESSAGE}`);
    }
    throw error;
  }
}

/** Accepts a Date or a parseable timestamp; null for empty input. Never echoes the rejected value. */
function normalizeOptionalTimestamp(value, errorCode = 'RULE_INVALID_DATE') {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
  } else if (typeof value === 'string') {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new HttpError(400, errorCode, 'timestamp must be a valid date/time');
}

/** An array/object is serialized with JSON.stringify so the JSON column gets a stable document. */
function serializeTokenField(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function assertApproved(status, approvedBy, approvedAt, errorCode, entity) {
  if (status === 'approved' && (approvedBy == null || approvedAt == null)) {
    throw new HttpError(400, errorCode, `an approved ${entity} requires approved_by and approved_at`);
  }
}

/**
 * Canonical attendance_rule_version row. NOTE: late_after vs work_start ordering is business policy and is
 * deliberately NOT validated - a rule may legitimately define a threshold before the shift starts.
 */
function normalizeRuleVersionInput(input) {
  const source = input || {};

  const ruleVersionCode = normalizeCode(source.ruleVersionCode, 'RULE_INVALID_CODE', 'rule_version_code');
  const name = normalizeName(source.name, 'RULE_INVALID_NAME', 'name');
  const status = normalizeStatus(source.status, RULE_STATUS, 'RULE_INVALID_STATUS', 'status');

  const effectiveFrom = normalizeEffectiveDate(source.effectiveFrom, 'effective_from');
  if (effectiveFrom == null) {
    throw new HttpError(400, 'RULE_INVALID_DATE', 'effective_from is required');
  }
  const effectiveTo = normalizeEffectiveDate(source.effectiveTo, 'effective_to');
  if (effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'RULE_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
  }

  const workStart = normalizeClock(source.workStart, 'work_start', 'RULE_INVALID_TIME');
  const workEnd = normalizeClock(source.workEnd, 'work_end', 'RULE_INVALID_TIME');
  const lateAfter = normalizeClock(source.lateAfter, 'late_after', 'RULE_INVALID_TIME');
  const earlyBefore = normalizeClock(source.earlyBefore, 'early_before', 'RULE_INVALID_TIME');

  let maxShiftSpanMinutes = 960;
  if (source.maxShiftSpanMinutes !== undefined
    && source.maxShiftSpanMinutes !== null
    && source.maxShiftSpanMinutes !== '') {
    maxShiftSpanMinutes = Number(source.maxShiftSpanMinutes);
    if (!Number.isInteger(maxShiftSpanMinutes) || maxShiftSpanMinutes <= 0) {
      throw new HttpError(400, 'RULE_INVALID_SPAN', 'max_shift_span_minutes must be a positive integer');
    }
  }

  const approvedBy = normalizeOptionalText(source.approvedBy);
  const approvedAt = normalizeOptionalTimestamp(source.approvedAt, 'RULE_INVALID_DATE');
  assertApproved(status, approvedBy, approvedAt, 'RULE_INVALID_APPROVAL', 'rule version');

  // The approved rule owns the working week. Optional on purpose: when it is absent the engine falls back
  // to Mon-Fri and records that it defaulted, rather than the value being silently assumed here.
  let workDays = null;
  if (source.workDays !== undefined && source.workDays !== null && source.workDays !== '') {
    const list = Array.isArray(source.workDays) ? source.workDays : [source.workDays];
    const parsed = list.map((day) => Number(day));
    if (!parsed.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
      throw new HttpError(400, 'RULE_INVALID_WORK_DAYS', 'work_days must be ISO-8601 day numbers 1..7');
    }
    workDays = Array.from(new Set(parsed)).sort((a, b) => a - b);
  }

  return {
    ruleVersionCode,
    name,
    status,
    effectiveFrom,
    effectiveTo,
    workStart,
    workEnd,
    lateAfter,
    earlyBefore,
    overnightShift: coerceBoolean(source.overnightShift, false),
    maxShiftSpanMinutes,
    ignoreHolidays: coerceBoolean(source.ignoreHolidays, true),
    workDays,
    leaveTypesJson: serializeTokenField(source.leaveTypesJson),
    leaveAliasesJson: serializeTokenField(source.leaveAliasesJson),
    businessStatusesJson: serializeTokenField(source.businessStatusesJson),
    sourceOfTruth: normalizeOptionalText(source.sourceOfTruth),
    approvedBy,
    approvedAt,
    notes: normalizeOptionalText(source.notes),
  };
}

/** Canonical attendance_schedule row. `workDays` stays an ordered array; the repo serializes it. */
function normalizeScheduleInput(input) {
  const source = input || {};

  const scheduleCode = normalizeCode(source.scheduleCode, 'SCHEDULE_INVALID_CODE', 'schedule_code');
  const employeeUid = trimmed(source.employeeUid);
  if (employeeUid === '') {
    throw new HttpError(400, 'SCHEDULE_INVALID_EMPLOYEE', 'employee_uid is required');
  }
  const name = normalizeName(source.name, 'SCHEDULE_INVALID_NAME', 'name');
  const status = normalizeStatus(source.status, SCHEDULE_STATUS, 'SCHEDULE_INVALID_STATUS', 'status');

  const effectiveFrom = normalizeDateWithCode(source.effectiveFrom, 'effective_from', 'SCHEDULE_INVALID_DATE');
  if (effectiveFrom == null) {
    throw new HttpError(400, 'SCHEDULE_INVALID_DATE', 'effective_from is required');
  }
  const effectiveTo = normalizeDateWithCode(source.effectiveTo, 'effective_to', 'SCHEDULE_INVALID_DATE');
  if (effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'SCHEDULE_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
  }

  const workStart = normalizeClock(source.workStart, 'work_start', 'SCHEDULE_INVALID_TIME');
  const workEnd = normalizeClock(source.workEnd, 'work_end', 'SCHEDULE_INVALID_TIME');
  const lateAfter = normalizeClock(source.lateAfter, 'late_after', 'SCHEDULE_INVALID_TIME');
  const earlyBefore = normalizeClock(source.earlyBefore, 'early_before', 'SCHEDULE_INVALID_TIME');

  if (!Array.isArray(source.workDays) || source.workDays.length === 0) {
    throw new HttpError(400, 'SCHEDULE_INVALID_WORK_DAYS', 'work_days must be a non-empty array of ISO day numbers (1..7)');
  }
  const workDays = source.workDays.map((day) => Number(day));
  const daysValid = workDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  const daysUnique = new Set(workDays).size === workDays.length;
  if (!daysValid || !daysUnique) {
    throw new HttpError(400, 'SCHEDULE_INVALID_WORK_DAYS', 'work_days must be unique ISO day numbers between 1 and 7');
  }

  const approvedBy = normalizeOptionalText(source.approvedBy);
  const approvedAt = normalizeOptionalTimestamp(source.approvedAt, 'SCHEDULE_INVALID_DATE');
  assertApproved(status, approvedBy, approvedAt, 'SCHEDULE_INVALID_APPROVAL', 'schedule');

  return {
    scheduleCode,
    employeeUid,
    name,
    status,
    effectiveFrom,
    effectiveTo,
    workStart,
    workEnd,
    lateAfter,
    earlyBefore,
    workDays,
    overnightShift: coerceBoolean(source.overnightShift, false),
    sourceSystem: normalizeOptionalText(source.sourceSystem) || 'manual',
    sourceReference: normalizeOptionalText(source.sourceReference),
    approvedBy,
    approvedAt,
  };
}

/**
 * Canonical attendance_holiday row. `org_unit_code` is required for a department holiday and must be null
 * for national/university rows, matching the scope_key unique key in migration 022.
 */
function normalizeHolidayInput(input) {
  const source = input || {};

  const holidayDate = normalizeDateWithCode(source.holidayDate, 'holiday_date', 'HOLIDAY_INVALID_DATE');
  if (holidayDate == null) {
    throw new HttpError(400, 'HOLIDAY_INVALID_DATE', 'holiday_date is required');
  }
  const name = normalizeName(source.name, 'HOLIDAY_INVALID_NAME', 'name');
  const scope = normalizeStatus(source.scope, HOLIDAY_SCOPE, 'HOLIDAY_INVALID_SCOPE', 'scope');

  const orgUnitCode = normalizeOptionalText(source.orgUnitCode);
  if (scope === 'department' && orgUnitCode == null) {
    throw new HttpError(400, 'HOLIDAY_INVALID_ORG_UNIT', 'a department holiday requires org_unit_code');
  }
  if (scope !== 'department' && orgUnitCode != null) {
    throw new HttpError(400, 'HOLIDAY_INVALID_ORG_UNIT', 'org_unit_code is only allowed for a department holiday');
  }

  const status = normalizeStatus(source.status, HOLIDAY_STATUS, 'HOLIDAY_INVALID_STATUS', 'status');
  const approvedBy = normalizeOptionalText(source.approvedBy);
  const approvedAt = normalizeOptionalTimestamp(source.approvedAt, 'HOLIDAY_INVALID_DATE');
  assertApproved(status, approvedBy, approvedAt, 'HOLIDAY_INVALID_APPROVAL', 'holiday');

  return {
    holidayDate,
    name,
    scope,
    orgUnitCode,
    status,
    sourceSystem: normalizeOptionalText(source.sourceSystem) || 'manual',
    sourceReference: normalizeOptionalText(source.sourceReference),
    approvedBy,
    approvedAt,
  };
}

// --- row coercion -------------------------------------------------------------

const TIME_KEYS_SET = new Set(TIME_KEYS);

/** Formats an unknown TIME value; returns a string that parseTimeToMinutes may still reject. */
function clockFromUnknown(value) {
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    const hours = Number(value.hours);
    const minutes = Number(value.minutes);
    const seconds = value.seconds === undefined ? 0 : Number(value.seconds);
    if ([hours, minutes, seconds].every((part) => Number.isInteger(part) && part >= 0)) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
  }
  return String(value);
}

function normalizeClockValue(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return minutesToTimeString(parseTimeToMinutes(clockFromUnknown(value)));
  } catch {
    // An uninterpretable TIME is reported as null rather than as a wrong time.
    return null;
  }
}

/**
 * Converts the TIME columns of a DB/fixture row to canonical 'HH:MM:SS' strings. Handles 'HH:MM:SS',
 * 'HH:MM' and the { hours, minutes, seconds } object shape some drivers return; an uninterpretable value
 * becomes null.
 */
function normalizeTimeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const normalized = { ...row };
  for (const key of Object.keys(normalized)) {
    if (TIME_KEYS_SET.has(key)) normalized[key] = normalizeClockValue(normalized[key]);
  }
  return normalized;
}

module.exports = {
  RULE_STATUS,
  SCHEDULE_STATUS,
  HOLIDAY_STATUS,
  HOLIDAY_SCOPE,
  COMPUTATION_STATUS,
  DAY_CLASSIFICATION,
  DEFAULT_RULE_CODES,
  DEFAULT_WORK_DAYS,
  parseTimeToMinutes,
  minutesToTimeString,
  normalizeEffectiveDate,
  isRuleEffectiveOn,
  isScheduleEffectiveOn,
  parsePolicyTokens,
  isWorkDay,
  normalizeRuleVersionInput,
  normalizeScheduleInput,
  normalizeHolidayInput,
  normalizeTimeRow,
};
