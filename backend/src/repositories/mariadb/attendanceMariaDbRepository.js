const { mapRow, mapRows } = require('./rowMapper');

function createAttendanceMariaDbRepository(pool) {
  return {
    async findDaily(date) {
      const [rows] = await pool.query(
        `SELECT employee_uid, date, check_in, check_out, is_late, late_minutes, work_duration, status
         FROM daily_attendance WHERE date = ? ORDER BY employee_uid`,
        [date],
      );
      return mapRows(rows);
    },

    async latestDailyDate(start, end) {
      const [rows] = await pool.query(
        "SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS latest FROM daily_attendance WHERE date BETWEEN ? AND ?",
        [start, end],
      );
      return rows[0].latest || null;
    },

    async findMonthly(employeeUid, year, month) {
      const [rows] = await pool.query(
        `SELECT employee_uid, year, month, total_work_days, total_present, total_late, total_absent,
                total_leave, total_late_minutes, total_work_hours
         FROM monthly_summary
         WHERE employee_uid = ? AND year = ? AND month = ?
         LIMIT 1`,
        [employeeUid, year, month],
      );
      return mapRow(rows[0]);
    },

    async findForEmployee(employeeUid) {
      const [rows] = await pool.query(
        `SELECT employee_uid, date, check_in, check_out, is_late, late_minutes, early_minutes, work_duration, status,
                computation_status, day_classification, rule_version_code, source_system
         FROM daily_attendance WHERE employee_uid = ? ORDER BY date DESC`,
        [employeeUid],
      );
      return mapRows(rows);
    },

    /** Every stored day row in [start,end] across all employees, for period analytics. */
    async listForPeriod(start, end) {
      const [rows] = await pool.query(
        `SELECT employee_uid, date, status, computation_status, day_classification,
                is_late, late_minutes, early_minutes, work_duration, is_leave
         FROM daily_attendance
         WHERE date BETWEEN ? AND ?
         ORDER BY employee_uid, date`,
        [start, end],
      );
      return mapRows(rows);
    },

    /** Idempotent by uk_daily_attendance_employee_date: a correction updates the day in place. */
    async upsertDay(record) {
      await pool.query(
        `INSERT INTO daily_attendance
           (employee_uid, date, check_in, check_out, is_late, late_minutes, early_minutes,
            work_duration, is_leave, leave_type, status, notes, source_system, rule_version_code,
            computation_status, day_classification, is_overnight, source_event_count,
            first_event_at, last_event_at, calculated_at, reconciliation_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
           check_in=VALUES(check_in), check_out=VALUES(check_out), is_late=VALUES(is_late),
           late_minutes=VALUES(late_minutes), early_minutes=VALUES(early_minutes),
           work_duration=VALUES(work_duration), is_leave=VALUES(is_leave),
           leave_type=VALUES(leave_type), status=VALUES(status), notes=VALUES(notes),
           source_system=VALUES(source_system), rule_version_code=VALUES(rule_version_code),
           computation_status=VALUES(computation_status), day_classification=VALUES(day_classification),
           is_overnight=VALUES(is_overnight), source_event_count=VALUES(source_event_count),
           first_event_at=VALUES(first_event_at), last_event_at=VALUES(last_event_at),
           calculated_at=VALUES(calculated_at), reconciliation_json=VALUES(reconciliation_json),
           updated_at=UTC_TIMESTAMP()`,
        [
          record.employeeUid, record.date, record.checkIn, record.checkOut, record.isLate,
          record.lateMinutes, record.earlyMinutes, record.workDuration, record.isLeave,
          record.leaveType, record.status, record.notes, record.sourceSystem,
          record.ruleVersionCode, record.computationStatus, record.dayClassification,
          record.isOvernight, record.sourceEventCount, record.firstEventAt, record.lastEventAt,
          record.calculatedAt, record.reconciliation,
        ],
      );
      return record;
    },

    /** Idempotent by uk_monthly_summary_employee_period. */
    async upsertMonthly(summary) {
      await pool.query(
        `INSERT INTO monthly_summary
           (employee_uid, year, month, total_work_days, total_present, total_late, total_absent,
            total_leave, total_late_minutes, total_early_minutes, total_work_hours,
            computation_status, rule_versions_json, expected_working_days, pending_days,
            holiday_days, day_counts_json, derivation_notes, calculated_at, source_kind,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
           total_work_days=VALUES(total_work_days), total_present=VALUES(total_present),
           total_late=VALUES(total_late), total_absent=VALUES(total_absent),
           total_leave=VALUES(total_leave), total_late_minutes=VALUES(total_late_minutes),
           total_early_minutes=VALUES(total_early_minutes), total_work_hours=VALUES(total_work_hours),
           computation_status=VALUES(computation_status), rule_versions_json=VALUES(rule_versions_json),
           expected_working_days=VALUES(expected_working_days), pending_days=VALUES(pending_days),
           holiday_days=VALUES(holiday_days), day_counts_json=VALUES(day_counts_json),
           derivation_notes=VALUES(derivation_notes), calculated_at=VALUES(calculated_at),
           source_kind=VALUES(source_kind), updated_at=UTC_TIMESTAMP()`,
        [
          summary.employeeUid, summary.year, summary.month, summary.totalWorkDays,
          summary.totalPresent, summary.totalLate, summary.totalAbsent, summary.totalLeave,
          summary.totalLateMinutes, summary.totalEarlyMinutes, summary.totalWorkHours,
          summary.computationStatus, JSON.stringify(summary.ruleVersions ?? []),
          summary.expectedWorkingDays, summary.pendingDays, summary.holidayDays,
          JSON.stringify(summary.dayCounts ?? {}), summary.derivationNotes,
          summary.calculatedAt, summary.sourceKind,
        ],
      );
      return summary;
    }
  };
}

module.exports = { createAttendanceMariaDbRepository };
