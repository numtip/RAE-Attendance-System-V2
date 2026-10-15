const { mapRow } = require('./rowMapper');
const { HttpError } = require('../../utils/httpError');

// ---------------------------------------------------------------------------
// Daily attendance provenance WRITE side (Slice 2) - MariaDB twin.
//
// This is the WRITE side only. The existing read-side repository is
// mariadb/attendanceMariaDbRepository.js; it is a separate file and is not touched here.
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
// The columns are DATE/DATETIME and the pool sets timezone 'Z', so mysql2 hands back a JS Date. Every
// Date is rendered DELIBERATELY here: a DATE via toISOString().slice(0,10), a DATETIME as
// 'YYYY-MM-DD HH:MM:SS' in UTC. The fixture twin stores strings directly, so both must render the same
// strings or the twins disagree - the precedent is the `wallDateOnly` comment in utils/bangkokTime.js
// (do not import or modify that file). The validators below are kept in lockstep with
// fixtureDailyAttendanceRepository.js; change one only together with the other.
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

const COLUMNS = `id, employee_uid, date, check_in, check_out, is_late, late_minutes, early_minutes,
  work_duration, is_leave, leave_type, status, notes, source_system, rule_version_code, schedule_code,
  computation_status, day_classification, is_overnight, source_event_count, first_event_at, last_event_at,
  calculated_at, reconciliation_json, created_at, updated_at`;

// Idempotent on uk_daily_attendance_employee_date (employee_uid, date): one row per employee-day, replaced
// in place. created_at is never rewritten by an update.
const UPSERT_SQL = `INSERT INTO daily_attendance (
    employee_uid, date, check_in, check_out, is_late, late_minutes, early_minutes, work_duration,
    is_leave, leave_type, status, notes, source_system, rule_version_code, schedule_code,
    computation_status, day_classification, is_overnight, source_event_count, first_event_at,
    last_event_at, calculated_at, reconciliation_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    check_in = VALUES(check_in),
    check_out = VALUES(check_out),
    is_late = VALUES(is_late),
    late_minutes = VALUES(late_minutes),
    early_minutes = VALUES(early_minutes),
    work_duration = VALUES(work_duration),
    is_leave = VALUES(is_leave),
    leave_type = VALUES(leave_type),
    status = VALUES(status),
    notes = VALUES(notes),
    source_system = VALUES(source_system),
    rule_version_code = VALUES(rule_version_code),
    schedule_code = VALUES(schedule_code),
    computation_status = VALUES(computation_status),
    day_classification = VALUES(day_classification),
    is_overnight = VALUES(is_overnight),
    source_event_count = VALUES(source_event_count),
    first_event_at = VALUES(first_event_at),
    last_event_at = VALUES(last_event_at),
    calculated_at = VALUES(calculated_at),
    reconciliation_json = VALUES(reconciliation_json),
    updated_at = VALUES(updated_at)`;

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

function formatDateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatDateTimeUtc(value) {
  if (value == null) return null;
  // A Date comes from mysql2 with timezone 'Z' (naive wall time round-trips through UTC); the ISO prefix
  // is exactly the 'YYYY-MM-DD HH:MM:SS' we want. A string is treated the same way.
  return String(value instanceof Date ? value.toISOString() : value)
    .trim()
    .slice(0, 19)
    .replace('T', ' ');
}

function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function dedupeSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Same value-free validation as the fixture twin (see that file for the rationale). */
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
    calculatedAt: input.calculatedAt == null ? null : new Date(input.calculatedAt),
    reconciliationJson: input.reconciliationJson == null ? null : input.reconciliationJson,
    sourceEventIds: dedupeSorted(input.sourceEventIds),
  };
}

function mapRecord(row) {
  if (!row) return null;
  const m = mapRow(row);
  return {
    id: m.id,
    employeeUid: m.employeeUid,
    date: formatDateOnly(m.date),
    checkIn: formatDateTimeUtc(m.checkIn),
    checkOut: formatDateTimeUtc(m.checkOut),
    isLate: Boolean(m.isLate),
    lateMinutes: Number(m.lateMinutes),
    earlyMinutes: Number(m.earlyMinutes),
    workDuration: Number(m.workDuration),
    isLeave: Boolean(m.isLeave),
    leaveType: m.leaveType ?? null,
    status: m.status,
    notes: m.notes ?? null,
    sourceSystem: m.sourceSystem ?? null,
    ruleVersionCode: m.ruleVersionCode ?? null,
    scheduleCode: m.scheduleCode ?? null,
    computationStatus: m.computationStatus,
    dayClassification: m.dayClassification ?? null,
    isOvernight: Boolean(m.isOvernight),
    sourceEventCount: Number(m.sourceEventCount),
    firstEventAt: formatDateTimeUtc(m.firstEventAt),
    lastEventAt: formatDateTimeUtc(m.lastEventAt),
    calculatedAt: toIsoTimestamp(m.calculatedAt),
    reconciliationJson: parseJsonColumn(m.reconciliationJson),
    createdAt: toIsoTimestamp(m.createdAt),
    updatedAt: toIsoTimestamp(m.updatedAt),
  };
}

async function fetchSourceEventIds(runner, dailyAttendanceId) {
  const [rows] = await runner.query(
    `SELECT attendance_event_id FROM daily_attendance_source_event
     WHERE daily_attendance_id = ? ORDER BY attendance_event_id`,
    [dailyAttendanceId],
  );
  return rows.map((row) => Number(row.attendance_event_id));
}

function mapDbError(error) {
  if (error instanceof HttpError) return error;
  // fk_daily_attendance_source_event_event (bad attendance_event_id) or fk_*_employee (bad employee_uid).
  if (error && error.code === 'ER_NO_REFERENCED_ROW_2') {
    return new HttpError(404, 'DAILY_UNKNOWN_REFERENCE', 'Referenced employee or attendance event was not found');
  }
  return error;
}

function createDailyAttendanceMariaDbRepository(pool) {
  return {
    async upsertDay(input) {
      const v = validateUpsert(input);
      const now = new Date();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        try {
          await connection.query(UPSERT_SQL, [
            v.employeeUid,
            v.date,
            v.checkIn,
            v.checkOut,
            v.isLate ? 1 : 0,
            v.lateMinutes,
            v.earlyMinutes,
            v.workDuration,
            v.isLeave ? 1 : 0,
            v.leaveType,
            v.status,
            v.notes,
            v.sourceSystem,
            v.ruleVersionCode,
            v.scheduleCode,
            v.computationStatus,
            v.dayClassification,
            v.isOvernight ? 1 : 0,
            v.sourceEventCount,
            v.firstEventAt,
            v.lastEventAt,
            v.calculatedAt,
            v.reconciliationJson == null ? null : JSON.stringify(v.reconciliationJson),
            now,
            now,
          ]);

          const [rows] = await connection.query(
            `SELECT ${COLUMNS} FROM daily_attendance WHERE employee_uid = ? AND date = ? LIMIT 1`,
            [v.employeeUid, v.date],
          );
          const record = mapRecord(rows[0]);
          if (!record) throw new Error('daily_attendance upsert did not return a row');

          // Delete-then-insert, NOT ON DUPLICATE KEY UPDATE: a recalculation may legitimately reference a
          // DIFFERENT set of source events (for example after a mapping change), so stale links must go.
          // Both the upsert and this link rewrite live in ONE transaction: a failed link write must roll the
          // row back too, otherwise it could claim provenance it does not have.
          await connection.query(
            'DELETE FROM daily_attendance_source_event WHERE daily_attendance_id = ?',
            [record.id],
          );
          if (v.sourceEventIds.length > 0) {
            const placeholders = v.sourceEventIds.map(() => '(?, ?, ?)').join(', ');
            const params = [];
            for (const attendanceEventId of v.sourceEventIds) {
              params.push(record.id, attendanceEventId, now);
            }
            await connection.query(
              `INSERT INTO daily_attendance_source_event (daily_attendance_id, attendance_event_id, created_at)
               VALUES ${placeholders}`,
              params,
            );
          }

          record.sourceEventIds = await fetchSourceEventIds(connection, record.id);
          await connection.commit();
          return record;
        } catch (error) {
          try {
            await connection.rollback();
          } catch {
            /* nothing to roll back */
          }
          throw mapDbError(error);
        }
      } finally {
        connection.release();
      }
    },

    async findForEmployeeDate(employeeUid, date) {
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM daily_attendance WHERE employee_uid = ? AND date = ? LIMIT 1`,
        [employeeUid, date],
      );
      const record = mapRecord(rows[0]);
      if (!record) return null;
      record.sourceEventIds = await fetchSourceEventIds(pool, record.id);
      return record;
    },

    async listForRange({ employeeUid = null, from = null, to = null } = {}) {
      const clauses = [];
      const params = [];
      if (employeeUid != null) {
        clauses.push('employee_uid = ?');
        params.push(employeeUid);
      }
      if (from != null) {
        clauses.push('date >= ?');
        params.push(from);
      }
      if (to != null) {
        clauses.push('date <= ?');
        params.push(to);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM daily_attendance${where} ORDER BY employee_uid, date`,
        params,
      );
      const records = rows.map((row) => mapRecord(row));
      if (records.length === 0) return records;

      const ids = records.map((record) => record.id);
      const [linkRows] = await pool.query(
        `SELECT daily_attendance_id, attendance_event_id FROM daily_attendance_source_event
         WHERE daily_attendance_id IN (${ids.map(() => '?').join(', ')})
         ORDER BY attendance_event_id`,
        ids,
      );
      const byDailyId = new Map();
      for (const link of linkRows) {
        const key = Number(link.daily_attendance_id);
        if (!byDailyId.has(key)) byDailyId.set(key, []);
        byDailyId.get(key).push(Number(link.attendance_event_id));
      }
      for (const record of records) {
        record.sourceEventIds = byDailyId.get(record.id) || [];
      }
      return records;
    },

    async findSourceEventIds(employeeUid, date) {
      const [rows] = await pool.query(
        `SELECT e.attendance_event_id
           FROM daily_attendance_source_event e
           JOIN daily_attendance d ON d.id = e.daily_attendance_id
          WHERE d.employee_uid = ? AND d.date = ?
          ORDER BY e.attendance_event_id`,
        [employeeUid, date],
      );
      return rows.map((row) => Number(row.attendance_event_id));
    },

    async deleteForEmployeeDate(employeeUid, date) {
      // fk_daily_attendance_source_event_daily is ON DELETE CASCADE, so the links go with the row.
      const [result] = await pool.query(
        'DELETE FROM daily_attendance WHERE employee_uid = ? AND date = ?',
        [employeeUid, date],
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createDailyAttendanceMariaDbRepository };
