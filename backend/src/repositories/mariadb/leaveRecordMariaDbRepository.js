const { randomUUID } = require('node:crypto');
const { mapRows } = require('./rowMapper');

function isMissingTable(error) {
  return error && (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146);
}

function createLeaveRecordMariaDbRepository(pool) {
  return {
    /** Idempotent: the (employee, date, part, source) unique key makes a repeat a no-op. */
    async insertIgnore(records) {
      let inserted = 0;
      for (const record of records) {
        const [result] = await pool.query(
          `INSERT IGNORE INTO employee_leave_record
             (record_uid, employee_uid, leave_date, leave_type, day_part, day_fraction, review_status, review_reason,
              approval_status, source_system, source_period, source_line, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, NOW(), NOW())`,
          [randomUUID(), record.employeeUid, record.leaveDate, record.leaveType, record.dayPart, record.dayFraction,
            record.reviewStatus, record.reviewReason, record.sourceSystem, record.sourcePeriod, record.sourceLine],
        );
        inserted += result.affectedRows === 1 ? 1 : 0;
      }
      return inserted;
    },

    async upsertCoverage(entry) {
      await pool.query(
        `INSERT INTO employee_leave_record_coverage (source_system, source_period, rows_scanned, employees_in_source, imported_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE rows_scanned = VALUES(rows_scanned), employees_in_source = VALUES(employees_in_source), imported_at = NOW()`,
        [entry.sourceSystem, entry.sourcePeriod, entry.rowsScanned, entry.employeesInSource],
      );
    },

    async listBetween(start, end) {
      try {
        const [rows] = await pool.query(
          `SELECT record_uid, employee_uid, DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date, leave_type, day_part, day_fraction,
                  review_status, review_reason, approval_status, source_system, reviewed_by_uid,
                  DATE_FORMAT(reviewed_at, '%Y-%m-%d %H:%i:%s') AS reviewed_at, review_note
             FROM employee_leave_record WHERE leave_date BETWEEN ? AND ? ORDER BY leave_date, employee_uid`,
          [start, end],
        );
        return mapRows(rows).map((row) => ({ ...row, dayFraction: row.dayFraction === null ? null : Number(row.dayFraction) }));
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /** Every record of one employee (any period). Missing table = no rows. */
    async listForEmployee(employeeUid) {
      try {
        const [rows] = await pool.query(
          `SELECT record_uid, employee_uid, DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date, leave_type, day_part, day_fraction,
                  review_status, review_reason, approval_status, source_system
             FROM employee_leave_record WHERE employee_uid = ? ORDER BY leave_date DESC, day_part`,
          [employeeUid],
        );
        return mapRows(rows).map((row) => ({ ...row, dayFraction: row.dayFraction === null ? null : Number(row.dayFraction) }));
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    async findByUid(recordUid) {
      const [rows] = await pool.query(
        `SELECT record_uid, employee_uid, DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date, leave_type, day_part, day_fraction,
                review_status, review_reason, approval_status, source_system
           FROM employee_leave_record WHERE record_uid = ?`,
        [recordUid],
      );
      if (rows.length === 0) return null;
      const [row] = mapRows(rows);
      return { ...row, dayFraction: row.dayFraction === null ? null : Number(row.dayFraction) };
    },

    /**
     * Apply one decision and append its audit row atomically. `patch` carries the new column values;
     * a duplicate (employee, date, part, source) is reported as { conflict: true } and nothing changes.
     */
    async applyDecision(recordUid, patch, audit) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(
          `UPDATE employee_leave_record
              SET leave_type = ?, day_part = ?, day_fraction = ?, review_status = ?, review_reason = ?,
                  approval_status = ?, reviewed_by_uid = ?, reviewed_at = NOW(), review_note = ?, updated_at = NOW()
            WHERE record_uid = ?`,
          [patch.leaveType, patch.dayPart, patch.dayFraction, patch.reviewStatus, patch.reviewReason,
            patch.approvalStatus, audit.actorUid, audit.note, recordUid],
        );
        await connection.query(
          `INSERT INTO employee_leave_record_audit (record_uid, actor_uid, action, before_state, after_state, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [recordUid, audit.actorUid, audit.action, audit.before, audit.after, audit.note],
        );
        await connection.commit();
        return { conflict: false };
      } catch (error) {
        await connection.rollback();
        if (error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) return { conflict: true };
        throw error;
      } finally {
        connection.release();
      }
    },

    async coveredPeriods() {
      try {
        const [rows] = await pool.query('SELECT DISTINCT source_period FROM employee_leave_record_coverage');
        return rows.map((row) => row.source_period);
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },
  };
}

module.exports = { createLeaveRecordMariaDbRepository };
