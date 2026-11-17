const { mapRows } = require('./rowMapper');

/**
 * `attendance_events` (migration 016) against MariaDB.
 *
 * Every DATETIME is formatted in SQL: mysql2 would hand back a Date and the pool runs with
 * timezone 'Z', so a JS-side slice is one configuration change away from a seven-hour shift.
 * The staging table stores Bangkok wall clock; the day write converts it back to an instant.
 */
function createAttendanceEventMariaDbRepository(pool) {
  return {
    async findResolvedStagingForDay(employeeUid, date) {
      const [rows] = await pool.query(
        `SELECT r.id,
                r.source_system,
                r.source_event_key,
                r.facescan_id,
                DATE_FORMAT(r.check_time, '%Y-%m-%dT%H:%i:%s') AS check_time,
                r.check_type,
                r.verify_code,
                r.sensor_id,
                r.work_code,
                r.import_batch_uid
           FROM staging_facescan_raw r
          WHERE r.employee_uid = ?
            AND r.resolution_status = 'resolved'
            AND r.check_time >= ?
            AND r.check_time < DATE_ADD(?, INTERVAL 1 DAY)
          ORDER BY r.check_time, r.id`,
        [employeeUid, date, date],
      );
      return mapRows(rows);
    },

    /** Idempotent on uk_attendance_events_staging_raw and uk_attendance_events_source_event. */
    async insertEvent(row) {
      await pool.query(
        `INSERT INTO attendance_events
           (event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid, source_system,
            source_event_key, facescan_id, event_time, check_type, verify_code, sensor_id, work_code,
            normalized_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          row.eventUid, row.employeeUid, row.stagingFacescanRawId, row.importBatchUid,
          row.sourceSystem, row.sourceEventKey, row.facescanId, row.eventTime, row.checkType ?? null,
          row.verifyCode ?? null, row.sensorId ?? null, row.workCode ?? null,
          row.normalizedAt, row.createdAt,
        ],
      );
      return row;
    },

    async findDay(employeeUid, date) {
      const [rows] = await pool.query(
        `SELECT e.id, e.event_uid, e.employee_uid, e.staging_facescan_raw_id, e.import_batch_uid,
                e.source_system, e.source_event_key, e.source_type, e.facescan_id,
                DATE_FORMAT(e.event_time, '%Y-%m-%dT%H:%i:%s') AS event_time,
                e.check_type, e.verify_code, e.sensor_id, e.work_code, e.timezone_label,
                DATE_FORMAT(e.normalized_at, '%Y-%m-%dT%H:%i:%s') AS normalized_at
           FROM attendance_events e
          WHERE e.employee_uid = ?
            AND e.event_time >= ?
            AND e.event_time < DATE_ADD(?, INTERVAL 1 DAY)
          ORDER BY e.event_time, e.id`,
        [employeeUid, date, date],
      );
      return mapRows(rows);
    },
  };
}

module.exports = { createAttendanceEventMariaDbRepository };
