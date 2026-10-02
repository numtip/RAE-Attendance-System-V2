const { mapRow } = require('./rowMapper');

function mapBatch(row) {
  if (!row) return null;
  const m = mapRow(row);
  return {
    batchUid: m.batchUid,
    sourceSystem: m.sourceSystem,
    sourceType: m.sourceType,
    sourceReference: m.sourceReference,
    windowFrom: m.windowFrom,
    windowTo: m.windowTo,
    status: m.status,
    rowsRead: m.rowsRead,
    rowsInserted: m.rowsInserted,
    rowsDuplicate: m.rowsDuplicate,
    rowsUnmapped: m.rowsUnmapped,
    rowsFailed: m.rowsFailed,
    startedAt: new Date(m.startedAt).toISOString(),
    completedAt: m.completedAt ? new Date(m.completedAt).toISOString() : null,
    errorSummary: m.errorSummary,
    createdAt: new Date(m.createdAt).toISOString(),
    updatedAt: new Date(m.updatedAt).toISOString(),
  };
}

function mapEvent(row) {
  if (!row) return null;
  const m = mapRow(row);
  return {
    id: m.id,
    sourceSystem: m.sourceSystem,
    sourceEventKey: m.sourceEventKey,
    facescanId: m.facescanId,
    checkTime: m.checkTime,
    checkType: m.checkType,
    verifyCode: m.verifyCode,
    sensorId: m.sensorId,
    workCode: m.workCode,
    employeeUid: m.employeeUid,
    resolutionStatus: m.resolutionStatus,
    importBatchUid: m.importBatchUid,
    rawPayload: m.rawPayload,
    importedAt: new Date(m.importedAt).toISOString(),
    resolvedAt: m.resolvedAt ? new Date(m.resolvedAt).toISOString() : null,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

function createFacescanIngestionMariaDbRepository(pool) {
  return {
    async createBatch(input) {
      const now = new Date();
      await pool.query(
        `INSERT INTO facescan_import_batches (
           batch_uid, source_system, source_type, source_reference, window_from, window_to,
           started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchUid,
          input.sourceSystem,
          input.sourceType,
          input.sourceReference ?? null,
          input.windowFrom ?? null,
          input.windowTo ?? null,
          now,
          now,
          now,
        ],
      );
      return this.findBatch(input.batchUid);
    },

    async findBatch(batchUid) {
      const [rows] = await pool.query(
        `SELECT batch_uid, source_system, source_type, source_reference, window_from, window_to,
                status, rows_read, rows_inserted, rows_duplicate, rows_unmapped, rows_failed,
                started_at, completed_at, error_summary, created_at, updated_at
         FROM facescan_import_batches WHERE batch_uid = ? LIMIT 1`,
        [batchUid],
      );
      return mapBatch(rows[0]);
    },

    async updateBatch(batchUid, patch) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches
         SET rows_read = ?, rows_inserted = ?, rows_duplicate = ?, rows_unmapped = ?, rows_failed = ?,
             error_summary = ?, updated_at = ?
         WHERE batch_uid = ?`,
        [
          patch.rowsRead,
          patch.rowsInserted,
          patch.rowsDuplicate,
          patch.rowsUnmapped,
          patch.rowsFailed,
          patch.errorSummary ?? null,
          now,
          batchUid,
        ],
      );
      return this.findBatch(batchUid);
    },

    async completeBatch(batchUid, patch = {}) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches
         SET status = ?, completed_at = ?, rows_read = ?, rows_inserted = ?, rows_duplicate = ?,
             rows_unmapped = ?, rows_failed = ?, error_summary = ?, updated_at = ?
         WHERE batch_uid = ?`,
        [
          patch.status || 'completed',
          now,
          patch.rowsRead,
          patch.rowsInserted,
          patch.rowsDuplicate,
          patch.rowsUnmapped,
          patch.rowsFailed,
          patch.errorSummary ?? null,
          now,
          batchUid,
        ],
      );
      return this.findBatch(batchUid);
    },

    async findBySourceEventKey(sourceEventKey) {
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw WHERE source_event_key = ? LIMIT 1`,
        [sourceEventKey],
      );
      return mapEvent(rows[0]);
    },

    async insertRawEvent(input) {
      const now = new Date();
      const [result] = await pool.query(
        `INSERT INTO staging_facescan_raw (
           source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
           sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
           imported_at, resolved_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sourceSystem,
          input.sourceEventKey,
          input.facescanId,
          input.checkTime,
          input.checkType,
          input.verifyCode,
          input.sensorId,
          input.workCode,
          input.employeeUid,
          input.resolutionStatus,
          input.importBatchUid,
          input.rawPayload ? JSON.stringify(input.rawPayload) : null,
          now,
          input.resolvedAt ?? null,
          now,
        ],
      );
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw WHERE id = ? LIMIT 1`,
        [result.insertId],
      );
      return mapEvent(rows[0]);
    },

    async listResolved({ importBatchUid } = {}) {
      const params = importBatchUid ? [importBatchUid] : [];
      const clause = importBatchUid ? ' AND import_batch_uid = ?' : '';
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw
         WHERE resolution_status = 'resolved' AND employee_uid IS NOT NULL${clause}
         ORDER BY id`,
        params,
      );
      return rows.map((row) => mapEvent(row));
    },

    async findRawById(id) {
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw WHERE id = ? LIMIT 1`,
        [id],
      );
      return mapEvent(rows[0]);
    },

    async listUnmapped({ importBatchUid } = {}) {
      const params = importBatchUid ? [importBatchUid] : [];
      const clause = importBatchUid ? ' AND import_batch_uid = ?' : '';
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw
         WHERE resolution_status = 'unmapped'${clause}
         ORDER BY id`,
        params,
      );
      return rows.map((row) => mapEvent(row));
    },

    async resolveEvent(id, { employeeUid, resolutionStatus }) {
      const now = new Date();
      await pool.query(
        `UPDATE staging_facescan_raw
         SET employee_uid = ?, resolution_status = ?, resolved_at = ?
         WHERE id = ? AND resolution_status = 'unmapped'`,
        [employeeUid, resolutionStatus, now, id],
      );
      const [rows] = await pool.query(
        `SELECT id, source_system, source_event_key, facescan_id, check_time, check_type, verify_code,
                sensor_id, work_code, employee_uid, resolution_status, import_batch_uid, raw_payload,
                imported_at, resolved_at, created_at
         FROM staging_facescan_raw WHERE id = ? LIMIT 1`,
        [id],
      );
      return mapEvent(rows[0]);
    },

    async upsertUser(input) {
      const now = new Date();
      await pool.query(
        `INSERT INTO staging_facescan_users (
           facescan_id, badge_number, display_name, card_metadata, privilege, group_name,
           source_system, imported_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           badge_number = VALUES(badge_number),
           display_name = VALUES(display_name),
           card_metadata = VALUES(card_metadata),
           privilege = VALUES(privilege),
           group_name = VALUES(group_name),
           imported_at = VALUES(imported_at)`,
        [
          input.facescanId,
          input.badgeNumber ?? null,
          input.displayName ?? null,
          input.cardMetadata ?? null,
          input.privilege ?? null,
          input.groupName ?? null,
          input.sourceSystem,
          now,
          now,
        ],
      );
      return { facescanId: input.facescanId, sourceSystem: input.sourceSystem };
    },
  };
}

module.exports = { createFacescanIngestionMariaDbRepository };
