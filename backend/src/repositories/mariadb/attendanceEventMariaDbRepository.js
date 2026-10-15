const { randomUUID } = require('node:crypto');
const { mapRow } = require('./rowMapper');

function mapEvent(row) {
  if (!row) return null;
  const m = mapRow(row);
  return {
    id: m.id,
    eventUid: m.eventUid,
    employeeUid: m.employeeUid,
    stagingFacescanRawId: m.stagingFacescanRawId,
    importBatchUid: m.importBatchUid,
    sourceSystem: m.sourceSystem,
    sourceEventKey: m.sourceEventKey,
    sourceType: m.sourceType,
    facescanId: m.facescanId,
    eventTime: m.eventTime,
    checkType: m.checkType,
    verifyCode: m.verifyCode,
    sensorId: m.sensorId,
    workCode: m.workCode,
    timezoneLabel: m.timezoneLabel,
    normalizedAt: new Date(m.normalizedAt).toISOString(),
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

function createAttendanceEventMariaDbRepository(pool) {
  return {
    async findByStagingRawId(stagingFacescanRawId) {
      const [rows] = await pool.query(
        `SELECT id, event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
                source_system, source_event_key, source_type, facescan_id, event_time,
                check_type, verify_code, sensor_id, work_code, timezone_label,
                normalized_at, created_at
         FROM attendance_events WHERE staging_facescan_raw_id = ? LIMIT 1`,
        [stagingFacescanRawId],
      );
      return mapEvent(rows[0]);
    },

    async findBySourceEventKey(sourceSystem, sourceEventKey) {
      const [rows] = await pool.query(
        `SELECT id, event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
                source_system, source_event_key, source_type, facescan_id, event_time,
                check_type, verify_code, sensor_id, work_code, timezone_label,
                normalized_at, created_at
         FROM attendance_events WHERE source_system = ? AND source_event_key = ? LIMIT 1`,
        [sourceSystem, sourceEventKey],
      );
      return mapEvent(rows[0]);
    },

    /**
     * Slice 2: the scans for one employee over an inclusive date range, ordered so the caller can take the
     * first arrival and the last departure directly. The range is expressed on DATE(event_time) because
     * event_time is a naive Asia/Bangkok wall timestamp, and a day's events must be grouped by that wall
     * date rather than by a UTC instant.
     */
    async listForEmployeeRange({ employeeUid, from, to }) {
      const [rows] = await pool.query(
        `SELECT id, event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
                source_system, source_event_key, source_type, facescan_id, event_time,
                check_type, verify_code, sensor_id, work_code, timezone_label,
                normalized_at, created_at
         FROM attendance_events
         WHERE employee_uid = ? AND DATE(event_time) BETWEEN ? AND ?
         ORDER BY event_time ASC, id ASC`,
        [employeeUid, from, to],
      );
      return rows.map((row) => mapEvent(row));
    },

    /**
     * Slice 2: the distinct employees that have any normalized scan in an inclusive date range, so a range
     * recalculation knows which employee-days to (re)build without scanning every employee in the table.
     */
    async listEmployeeUidsWithEvents({ from, to }) {
      const [rows] = await pool.query(
        `SELECT DISTINCT employee_uid FROM attendance_events
         WHERE employee_uid IS NOT NULL AND DATE(event_time) BETWEEN ? AND ?
         ORDER BY employee_uid`,
        [from, to],
      );
      return rows.map((row) => row.employee_uid);
    },

    async insert(event) {
      const now = new Date();
      const eventUid = event.eventUid || randomUUID();
      try {
        const [result] = await pool.query(
          `INSERT INTO attendance_events (
             event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
             source_system, source_event_key, source_type, facescan_id, event_time,
             check_type, verify_code, sensor_id, work_code, timezone_label,
             normalized_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventUid,
            event.employeeUid,
            event.stagingFacescanRawId,
            event.importBatchUid,
            event.sourceSystem,
            event.sourceEventKey,
            event.sourceType,
            event.facescanId,
            event.eventTime,
            event.checkType,
            event.verifyCode,
            event.sensorId,
            event.workCode,
            event.timezoneLabel,
            now,
            now,
          ],
        );
        const [rows] = await pool.query(
          `SELECT id, event_uid, employee_uid, staging_facescan_raw_id, import_batch_uid,
                  source_system, source_event_key, source_type, facescan_id, event_time,
                  check_type, verify_code, sensor_id, work_code, timezone_label,
                  normalized_at, created_at
           FROM attendance_events WHERE id = ? LIMIT 1`,
          [result.insertId],
        );
        return mapEvent(rows[0]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          const msg = String(error.message || '');
          const dup = new Error('DUPLICATE_EVENT');
          if (msg.includes('uk_attendance_events_staging_raw')) {
            dup.code = 'DUPLICATE_STAGING_RAW';
          } else if (msg.includes('uk_attendance_events_source_event')) {
            dup.code = 'DUPLICATE_SOURCE_EVENT';
          } else {
            dup.code = 'DUPLICATE_EVENT';
          }
          throw dup;
        }
        throw error;
      }
    },
  };
}

module.exports = { createAttendanceEventMariaDbRepository };
