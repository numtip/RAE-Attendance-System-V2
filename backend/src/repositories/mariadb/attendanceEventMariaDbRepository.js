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
