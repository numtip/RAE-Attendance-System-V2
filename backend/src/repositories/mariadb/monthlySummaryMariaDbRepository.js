/**
 * MariaDB monthly_summary WRITE repository (migration 024).
 *
 * STRING-SHAPE CONTRACT (identical to fixtureMonthlySummaryRepository): both twins return the same JSON
 * shape. `ruleVersions` is always an array and `dayCounts` always an object — the JSON columns are
 * serialized here on write and parsed back on read, so no caller needs to know the backend. `calculatedAt`
 * is an ISO string or null. DATE/DATETIME columns come back from mysql2 as JS `Date` values because the pool
 * sets timezone 'Z', so they are rendered deliberately rather than passed through (see the
 * `String(value).slice(0, 10)` hazard documented in docs/unified/08_MIGRATION_DEPENDENCY_GRAPH.md §4).
 *
 * The upsert is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uk_monthly_summary_employee_period`, so a re-derivation is idempotent without a read-modify-write race.
 * There is no transaction: it is exactly one statement, and there is no second table to keep consistent.
 */
const { normalizeMonthInput } = require('../fixtureMonthlySummaryRepository');

function toFlag(value) {
  return value ? 1 : 0;
}

function toIsoTimestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

/** mysql2 parses JSON columns into objects, but a string is possible; accept both, always return an object. */
function parseJsonObject(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJsonArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const SELECT_COLUMNS = `id, employee_uid, year, month, total_work_days, total_present, total_late,
  total_absent, total_leave, total_late_minutes, total_early_minutes, total_work_hours,
  pending_days, holiday_days, expected_working_days, computation_status,
  rule_versions_json, day_counts_json, derivation_notes, calculated_at, source_kind,
  created_at, updated_at`;

const UPSERT_SQL = `INSERT INTO monthly_summary (
    employee_uid, year, month, total_work_days, total_present, total_late, total_absent, total_leave,
    total_late_minutes, total_early_minutes, total_work_hours, pending_days, holiday_days,
    expected_working_days, computation_status, rule_versions_json, day_counts_json,
    derivation_notes, calculated_at, source_kind, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    total_work_days = VALUES(total_work_days),
    total_present = VALUES(total_present),
    total_late = VALUES(total_late),
    total_absent = VALUES(total_absent),
    total_leave = VALUES(total_leave),
    total_late_minutes = VALUES(total_late_minutes),
    total_early_minutes = VALUES(total_early_minutes),
    total_work_hours = VALUES(total_work_hours),
    pending_days = VALUES(pending_days),
    holiday_days = VALUES(holiday_days),
    expected_working_days = VALUES(expected_working_days),
    computation_status = VALUES(computation_status),
    rule_versions_json = VALUES(rule_versions_json),
    day_counts_json = VALUES(day_counts_json),
    derivation_notes = VALUES(derivation_notes),
    calculated_at = VALUES(calculated_at),
    source_kind = VALUES(source_kind),
    updated_at = VALUES(updated_at)`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    employeeUid: row.employee_uid,
    year: Number(row.year),
    month: Number(row.month),
    totalWorkDays: Number(row.total_work_days),
    totalPresent: Number(row.total_present),
    totalLate: Number(row.total_late),
    totalAbsent: Number(row.total_absent),
    totalLeave: Number(row.total_leave),
    totalLateMinutes: Number(row.total_late_minutes),
    totalEarlyMinutes: Number(row.total_early_minutes),
    pendingDays: Number(row.pending_days),
    holidayDays: Number(row.holiday_days),
    // NULL must stay null: it means "could not be derived", not zero.
    expectedWorkingDays: row.expected_working_days == null ? null : Number(row.expected_working_days),
    totalWorkHours: Number(row.total_work_hours),
    computationStatus: row.computation_status,
    ruleVersions: parseJsonArray(row.rule_versions_json),
    dayCounts: parseJsonObject(row.day_counts_json),
    derivationNotes: row.derivation_notes == null ? null : String(row.derivation_notes),
    calculatedAt: toIsoTimestamp(row.calculated_at),
    sourceKind: row.source_kind,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function createMonthlySummaryMariaDbRepository(pool) {
  return {
    async upsertMonth(input) {
      const month = normalizeMonthInput(input);
      const now = new Date();
      try {
        await pool.query(UPSERT_SQL, [
          month.employeeUid,
          month.year,
          month.month,
          month.totalWorkDays,
          month.totalPresent,
          month.totalLate,
          month.totalAbsent,
          month.totalLeave,
          month.totalLateMinutes,
          month.totalEarlyMinutes,
          month.totalWorkHours,
          month.pendingDays,
          month.holidayDays,
          month.expectedWorkingDays,
          month.computationStatus,
          JSON.stringify(month.ruleVersions),
          JSON.stringify(month.dayCounts),
          month.derivationNotes,
          month.calculatedAt ? new Date(month.calculatedAt) : now,
          month.sourceKind,
          now,
          now,
        ]);
      } catch (error) {
        // fk_monthly_summary_employee is not present (monthly_summary predates the FK convention), so the
        // repository checks the employee itself in the service; a raw driver error here means something
        // else, and is surfaced unchanged rather than masked.
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
          const coded = new Error('MONTHLY_UNKNOWN_EMPLOYEE');
          coded.code = 'MONTHLY_UNKNOWN_EMPLOYEE';
          throw coded;
        }
        throw error;
      }
      return this.findForEmployeeMonth(month.employeeUid, month.year, month.month);
    },

    async findForEmployeeMonth(employeeUid, year, month) {
      const [rows] = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM monthly_summary
         WHERE employee_uid = ? AND year = ? AND month = ? LIMIT 1`,
        [employeeUid, Number(year), Number(month)],
      );
      return mapRow(rows[0]);
    },

    async listForEmployeeYear(employeeUid, year) {
      const [rows] = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM monthly_summary
         WHERE employee_uid = ? AND year = ? ORDER BY month ASC`,
        [employeeUid, Number(year)],
      );
      return rows.map(mapRow);
    },
  };
}

module.exports = { createMonthlySummaryMariaDbRepository, toFlag };
