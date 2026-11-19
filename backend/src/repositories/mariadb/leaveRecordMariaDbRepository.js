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
          `SELECT employee_uid, DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date, leave_type, day_part, day_fraction,
                  review_status, review_reason, approval_status, source_system
             FROM employee_leave_record WHERE leave_date BETWEEN ? AND ? ORDER BY leave_date`,
          [start, end],
        );
        return mapRows(rows).map((row) => ({ ...row, dayFraction: row.dayFraction === null ? null : Number(row.dayFraction) }));
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
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
