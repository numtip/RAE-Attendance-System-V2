const { HttpError } = require('../utils/httpError');

// ---------------------------------------------------------------------------
// Daily attendance provenance WRITE side (Slice 2).
//
// In-memory twin of src/repositories/mariadb/dailyAttendanceMariaDbRepository.js. Same method names,
// same returned record shape, same error codes, same string shapes.
//
// STRING-SHAPE CONTRACT (both twins must return the SAME strings for the SAME row):
//   * date                                -> 'YYYY-MM-DD'
//   * checkIn / checkOut                  -> 'YYYY-MM-DD HH:MM:SS' | null
//   * firstEventAt / lastEventAt          -> 'YYYY-MM-DD HH:MM:SS' | null
//   * calculatedAt / createdAt / updatedAt -> ISO-8601 UTC string ('2026-03-02T10:05:00.000Z')
//   * workDuration / lateMinutes / earlyMinutes / sourceEventCount -> number
//   * isLate / isLeave / isOvernight      -> boolean
//   * reconciliationJson                  -> object | null
//   * sourceEventIds                      -> number[] (sorted ascending, duplicates removed)
//
// The MariaDB twin stores DATE/DATETIME columns and the pool sets timezone 'Z', so mysql2 hands back a
// JS Date; it formats those back to the strings above. This fixture stores strings directly, so a shape
// mismatch is possible only if these two files drift. The precedent is the `wallDateOnly` comment in
// src/utils/bangkokTime.js: the same stored naive wall timestamp can arrive as a string or as a Date and
// both must render identically. Never change one of the twins without the other.
// ---------------------------------------------------------------------------

// 'pending' is part of the status ENUM as of migration 023: it is the honest state for a day whose facts
// are known but which cannot be judged (no approved rule, or uninterpretable scans).
const STATUS_VALUES = ['present', 'late', 'absent', 'leave', 'holiday', 'pending'];
const LEAVE_TYPE_VALUES = ['sick', 'personal', 'vacation', 'other'];
const COMPUTATION_STATUS_VALUES = [
  'calculated',
  'no_data',
  'insufficient_data',
  'pending_policy',
  'failed',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, 'DAILY_INVALID_COUNT', `${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * check_in / check_out are DATE-less in the caller contract but DATETIME in the table.
 *   * null / ''        -> null
 *   * 'HH:MM:SS'       -> combined with `date` ('YYYY-MM-DD' + ' ' + 'HH:MM:SS')
 *   * 'YYYY-MM-DD HH:MM:SS' -> passed through UNCHANGED (the lead engine may already combine it)
 * An unrecognised shape is stored as-is rather than guessed, so the caller keeps ownership of the value.
 */
function combineDateTime(date, value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (DATETIME_RE.test(text)) return text;
  if (TIME_RE.test(text)) return `${date} ${text}`;
  return text;
}

function normalizeWallTimestamp(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (DATETIME_RE.test(text)) return text;
  if (text.includes('T')) return text.slice(0, 19).replace('T', ' ');
  return text;
}

function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function dedupeSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Validation runs before any write so a bad payload never reaches the store and never lets the DB decide.
 * Every message is VALUE-FREE: the rejected value is never interpolated (a test asserts this).
 */
function validateUpsert(input) {
  if (!input || typeof input !== 'object'
    || typeof input.employeeUid !== 'string' || input.employeeUid.trim() === '') {
    throw new HttpError(400, 'DAILY_INVALID_EMPLOYEE', 'employeeUid is required');
  }
  if (!isRealDate(input.date)) {
    throw new HttpError(400, 'DAILY_INVALID_DATE', 'date must be a real ISO date (YYYY-MM-DD)');
  }
  const lateMinutes = requireNonNegativeInteger(input.lateMinutes, 'lateMinutes');
  const earlyMinutes = requireNonNegativeInteger(input.earlyMinutes, 'earlyMinutes');
  const sourceEventCount = requireNonNegativeInteger(input.sourceEventCount, 'sourceEventCount');

  if (typeof input.workDuration !== 'number'
    || !Number.isFinite(input.workDuration) || input.workDuration < 0) {
    throw new HttpError(400, 'DAILY_INVALID_DURATION', 'workDuration must be a finite number greater than or equal to zero');
  }
  if (!STATUS_VALUES.includes(input.status)) {
    throw new HttpError(400, 'DAILY_INVALID_STATUS', 'status must be one of the supported values');
  }
  if (input.leaveType != null && !LEAVE_TYPE_VALUES.includes(input.leaveType)) {
    throw new HttpError(400, 'DAILY_INVALID_LEAVE_TYPE', 'leaveType must be null or one of the supported values');
  }
  if (!COMPUTATION_STATUS_VALUES.includes(input.computationStatus)) {
    throw new HttpError(400, 'DAILY_INVALID_COMPUTATION_STATUS', 'computationStatus must be one of the supported values');
  }
  if (!Array.isArray(input.sourceEventIds)
    || input.sourceEventIds.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new HttpError(400, 'DAILY_INVALID_SOURCE_EVENTS', 'sourceEventIds must be an array of positive integers');
  }

  return {
    employeeUid: input.employeeUid,
    date: input.date,
    checkIn: combineDateTime(input.date, input.checkIn),
    checkOut: combineDateTime(input.date, input.checkOut),
    isLate: Boolean(input.isLate),
    lateMinutes,
    earlyMinutes,
    workDuration: input.workDuration,
    isLeave: Boolean(input.isLeave),
    leaveType: input.leaveType ?? null,
    status: input.status,
    notes: input.notes ?? null,
    sourceSystem: input.sourceSystem ?? null,
    ruleVersionCode: input.ruleVersionCode ?? null,
    scheduleCode: input.scheduleCode ?? null,
    computationStatus: input.computationStatus,
    dayClassification: input.dayClassification ?? null,
    isOvernight: Boolean(input.isOvernight),
    sourceEventCount,
    firstEventAt: normalizeWallTimestamp(input.firstEventAt),
    lastEventAt: normalizeWallTimestamp(input.lastEventAt),
    calculatedAt: toIsoTimestamp(input.calculatedAt),
    reconciliationJson: input.reconciliationJson == null ? null : cloneJson(input.reconciliationJson),
    sourceEventIds: dedupeSorted(input.sourceEventIds),
  };
}

function createFixtureDailyAttendanceRepository(initialRows = []) {
  let nextId = 1;
  /** @type {Array<object>} */
  const rows = [];
  /** @type {Array<{ dailyAttendanceId: number, attendanceEventId: number, createdAt: string }>} */
  const links = [];

  function keyOf(employeeUid, date) {
    return `${employeeUid}\u0000${date}`;
  }

  function linkIdsFor(dailyAttendanceId) {
    return links
      .filter((link) => link.dailyAttendanceId === dailyAttendanceId)
      .map((link) => link.attendanceEventId)
      .sort((a, b) => a - b);
  }

  function toRecord(row) {
    return {
      ...row,
      reconciliationJson: row.reconciliationJson == null ? null : cloneJson(row.reconciliationJson),
      sourceEventIds: linkIdsFor(row.id),
    };
  }

  function replaceLinks(dailyAttendanceId, sourceEventIds) {
    // Replace wholesale: a recalculation may legitimately carry a DIFFERENT set of source events
    // (for example after a mapping change), so an append or a blind upsert would leave stale provenance.
    for (let i = links.length - 1; i >= 0; i -= 1) {
      if (links[i].dailyAttendanceId === dailyAttendanceId) links.splice(i, 1);
    }
    const now = new Date().toISOString();
    for (const attendanceEventId of sourceEventIds) {
      links.push({ dailyAttendanceId, attendanceEventId, createdAt: now });
    }
  }

  for (const seed of initialRows) {
    const row = { ...seed };
    const seededIds = Array.isArray(row.sourceEventIds) ? dedupeSorted(row.sourceEventIds) : [];
    delete row.sourceEventIds;
    if (row.id == null) {
      row.id = nextId;
    }
    nextId = Math.max(nextId, Number(row.id) + 1);
    const now = new Date().toISOString();
    row.createdAt = row.createdAt || now;
    row.updatedAt = row.updatedAt || row.createdAt;
    rows.push(row);
    for (const attendanceEventId of seededIds) {
      links.push({ dailyAttendanceId: row.id, attendanceEventId, createdAt: now });
    }
  }

  return {
    async upsertDay(input) {
      const { sourceEventIds, ...fields } = validateUpsert(input);
      const key = keyOf(fields.employeeUid, fields.date);
      const now = new Date().toISOString();
      let row = rows.find((item) => keyOf(item.employeeUid, item.date) === key);
      if (row) {
        // Only bump updatedAt when the content actually changed, so a repeat upsert of the same input is a
        // true no-op that returns a byte-identical record (matches the "idempotent" contract).
        const changed = Object.keys(fields).some((field) => !sameValue(row[field], fields[field]));
        if (changed) Object.assign(row, fields, { updatedAt: now });
      } else {
        row = { id: nextId, ...fields, createdAt: now, updatedAt: now };
        nextId += 1;
        rows.push(row);
      }
      replaceLinks(row.id, sourceEventIds);
      return toRecord(row);
    },

    async findForEmployeeDate(employeeUid, date) {
      const row = rows.find((item) => item.employeeUid === employeeUid && item.date === date);
      return row ? toRecord(row) : null;
    },

    async listForRange({ employeeUid = null, from = null, to = null } = {}) {
      return rows
        .filter((row) => employeeUid == null || row.employeeUid === employeeUid)
        .filter((row) => from == null || row.date >= from)
        .filter((row) => to == null || row.date <= to)
        .sort((a, b) => {
          if (a.employeeUid !== b.employeeUid) return a.employeeUid < b.employeeUid ? -1 : 1;
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return 0;
        })
        .map((row) => toRecord(row));
    },

    async findSourceEventIds(employeeUid, date) {
      const row = rows.find((item) => item.employeeUid === employeeUid && item.date === date);
      return row ? linkIdsFor(row.id) : [];
    },

    async deleteForEmployeeDate(employeeUid, date) {
      const index = rows.findIndex((item) => item.employeeUid === employeeUid && item.date === date);
      if (index === -1) return false;
      const [removed] = rows.splice(index, 1);
      // Mirrors the FK CASCADE from daily_attendance: the links go with the row.
      for (let i = links.length - 1; i >= 0; i -= 1) {
        if (links[i].dailyAttendanceId === removed.id) links.splice(i, 1);
      }
      return true;
    },

    /** Test hook: a deep-ish copy of every stored row and its provenance links. */
    all() {
      return {
        rows: rows.map((row) => toRecord(row)),
        links: links.map((link) => ({ ...link })),
      };
    },
  };
}

module.exports = { createFixtureDailyAttendanceRepository };
