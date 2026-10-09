const { mapRow } = require('./rowMapper');

function mapBatch(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    id: mapped.id,
    sourceSystem: mapped.sourceSystem,
    sourceLabel: mapped.sourceLabel,
    status: mapped.status,
    rowCount: mapped.rowCount,
    insertedCount: mapped.insertedCount,
    duplicateCount: mapped.duplicateCount,
    unmappedCount: mapped.unmappedCount,
    resolvedCount: mapped.resolvedCount,
    startedAt: new Date(mapped.startedAt).toISOString(),
    finishedAt: mapped.finishedAt ? new Date(mapped.finishedAt).toISOString() : null,
    createdAt: new Date(mapped.createdAt).toISOString(),
    updatedAt: new Date(mapped.updatedAt).toISOString(),
  };
}

function mapRawRow(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    id: mapped.id,
    batchId: mapped.batchId,
    facescanId: mapped.facescanId,
    scanDatetime: mapped.scanDatetime,
    scanType: mapped.scanType,
    payloadJson: mapped.payloadJson,
    idempotencyKey: mapped.idempotencyKey,
    employeeUid: mapped.employeeUid,
    resolutionStatus: mapped.resolutionStatus,
    resolvedAt: mapped.resolvedAt ? new Date(mapped.resolvedAt).toISOString() : null,
    createdAt: new Date(mapped.createdAt).toISOString(),
    updatedAt: new Date(mapped.updatedAt).toISOString(),
  };
}

function createFacescanRawMariaDbRepository(pool) {
  return {
    async createBatch(input) {
      const now = new Date();
      await pool.query(
        `INSERT INTO facescan_import_batches (
           id, source_system, source_label, status, started_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        [input.id, input.sourceSystem || 'facescan_db', input.sourceLabel ?? null, now, now, now],
      );
      return this.findBatch(input.id);
    },

    async findBatch(id) {
      const [rows] = await pool.query(
        `SELECT id, source_system, source_label, status, row_count, inserted_count, duplicate_count,
                unmapped_count, resolved_count, started_at, finished_at, created_at, updated_at
         FROM facescan_import_batches WHERE id = ? LIMIT 1`,
        [id],
      );
      return mapBatch(rows[0]);
    },

    async updateBatchCounters(id, patch) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches
         SET row_count = ?, inserted_count = ?, duplicate_count = ?, unmapped_count = ?, resolved_count = ?, updated_at = ?
         WHERE id = ?`,
        [
          patch.rowCount,
          patch.insertedCount,
          patch.duplicateCount,
          patch.unmappedCount,
          patch.resolvedCount,
          now,
          id,
        ],
      );
      return this.findBatch(id);
    },

    async commitBatch(id) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches SET status = 'committed', finished_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, id],
      );
      return this.findBatch(id);
    },

    async findByIdempotencyKey(idempotencyKey) {
      const [rows] = await pool.query(
        `SELECT id, batch_id, facescan_id, scan_datetime, scan_type, payload_json, idempotency_key,
                employee_uid, resolution_status, resolved_at, created_at, updated_at
         FROM staging_facescan_raw WHERE idempotency_key = ? LIMIT 1`,
        [idempotencyKey],
      );
      return mapRawRow(rows[0]);
    },

    async insertRawRow(input) {
      const now = new Date();
      const [result] = await pool.query(
        `INSERT INTO staging_facescan_raw (
           batch_id, facescan_id, scan_datetime, scan_type, payload_json, idempotency_key,
           employee_uid, resolution_status, resolved_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.facescanId,
          input.scanDatetime,
          input.scanType,
          input.payloadJson ? JSON.stringify(input.payloadJson) : null,
          input.idempotencyKey,
          input.employeeUid,
          input.resolutionStatus,
          input.resolvedAt ?? null,
          now,
          now,
        ],
      );
      const [rows] = await pool.query(
        `SELECT id, batch_id, facescan_id, scan_datetime, scan_type, payload_json, idempotency_key,
                employee_uid, resolution_status, resolved_at, created_at, updated_at
         FROM staging_facescan_raw WHERE id = ? LIMIT 1`,
        [result.insertId],
      );
      return mapRawRow(rows[0]);
    },

    async listUnmapped({ batchId } = {}) {
      const params = batchId ? [batchId] : [];
      const clause = batchId ? ' AND batch_id = ?' : '';
      const [rows] = await pool.query(
        `SELECT id, batch_id, facescan_id, scan_datetime, scan_type, payload_json, idempotency_key,
                employee_uid, resolution_status, resolved_at, created_at, updated_at
         FROM staging_facescan_raw
         WHERE resolution_status = 'unmapped'${clause}
         ORDER BY id`,
        params,
      );
      return rows.map((row) => mapRawRow(row));
    },

    async resolveRow(id, { employeeUid, resolutionStatus }) {
      const now = new Date();
      await pool.query(
        `UPDATE staging_facescan_raw
         SET employee_uid = ?, resolution_status = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND resolution_status = 'unmapped'`,
        [employeeUid, resolutionStatus, now, now, id],
      );
      const [rows] = await pool.query(
        `SELECT id, batch_id, facescan_id, scan_datetime, scan_type, payload_json, idempotency_key,
                employee_uid, resolution_status, resolved_at, created_at, updated_at
         FROM staging_facescan_raw WHERE id = ? LIMIT 1`,
        [id],
      );
      return mapRawRow(rows[0]);
    },
  };
}

module.exports = { createFacescanRawMariaDbRepository };
