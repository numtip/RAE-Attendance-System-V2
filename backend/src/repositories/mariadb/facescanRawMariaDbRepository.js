const { mapRow } = require('./rowMapper');

/**
 * Facescan staging repository — MariaDB implementation.
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * It queried the schema `014_facescan_raw_ingestion` created, but `015_facescan_hip_ingestion` DROPs and
 * re-creates both staging tables with different column names, so every statement here failed on a migrated
 * database with `ER_BAD_FIELD_ERROR` (`Unknown column 'batch_id'`). The only test that exercised the ingestion
 * service used the fixture repository, so CI could not see it. Nothing about the migration is wrong — the
 * repository was the stale artifact.
 *
 * The mapping below is derived from the real schema, column by column, and every non-obvious one is annotated.
 * The object SHAPES the service consumes are unchanged; only the SQL and the column names moved.
 *
 *   facescan_import_batches        (015 + 021)
 *     batch_uid <- id            source_reference <- sourceLabel       completed_at <- finishedAt
 *     rows_read / rows_inserted / rows_duplicate / rows_unmapped <- row / inserted / duplicate / unmappedCount
 *     The status enum is ('open','completed','failed'), so a commit writes 'completed' — the previous
 *     'committed' was not a member.
 *     resolved_count has NO column: it is DERIVED from the staging rows (resolution_status = 'resolved'),
 *     which is where that truth now lives. It is neither invented nor silently dropped.
 *
 *   staging_facescan_raw
 *     import_batch_uid <- batchId    source_event_key <- idempotencyKey
 *     check_time <- scanDatetime     check_type <- scanType       raw_payload <- payloadJson
 *     There is no updated_at column, so the returned `updatedAt` is null rather than a fabricated timestamp.
 */
const BATCH_SELECT = `
  SELECT b.batch_uid AS id,
         b.source_system,
         b.source_reference AS source_label,
         b.status,
         b.rows_read AS row_count,
         b.rows_inserted AS inserted_count,
         b.rows_duplicate AS duplicate_count,
         b.rows_unmapped AS unmapped_count,
         (SELECT COUNT(*) FROM staging_facescan_raw s
           WHERE s.import_batch_uid = b.batch_uid AND s.resolution_status = 'resolved') AS resolved_count,
         b.started_at,
         b.completed_at AS finished_at,
         b.created_at,
         b.updated_at
    FROM facescan_import_batches b`;

const RAW_SELECT = `
  SELECT r.id,
         r.import_batch_uid AS batch_id,
         r.facescan_id,
         r.check_time AS scan_datetime,
         r.check_type AS scan_type,
         r.raw_payload AS payload_json,
         r.source_event_key AS idempotency_key,
         r.employee_uid,
         r.resolution_status,
         r.resolved_at,
         r.created_at,
         NULL AS updated_at
    FROM staging_facescan_raw r`;

function mapBatch(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    id: mapped.id,
    sourceSystem: mapped.sourceSystem,
    sourceLabel: mapped.sourceLabel,
    status: mapped.status,
    rowCount: Number(mapped.rowCount ?? 0),
    insertedCount: Number(mapped.insertedCount ?? 0),
    duplicateCount: Number(mapped.duplicateCount ?? 0),
    unmappedCount: Number(mapped.unmappedCount ?? 0),
    resolvedCount: Number(mapped.resolvedCount ?? 0),
    startedAt: new Date(mapped.startedAt).toISOString(),
    finishedAt: mapped.finishedAt ? new Date(mapped.finishedAt).toISOString() : null,
    createdAt: new Date(mapped.createdAt).toISOString(),
    updatedAt: mapped.updatedAt ? new Date(mapped.updatedAt).toISOString() : null,
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
    updatedAt: mapped.updatedAt ? new Date(mapped.updatedAt).toISOString() : null,
  };
}

function createFacescanRawMariaDbRepository(pool) {
  return {
    async createBatch(input) {
      const now = new Date();
      await pool.query(
        `INSERT INTO facescan_import_batches (
           batch_uid, source_system, source_reference, status, started_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        [input.id, input.sourceSystem || 'facescan_db', input.sourceLabel ?? null, now, now, now],
      );
      return this.findBatch(input.id);
    },

    async findBatch(id) {
      const [rows] = await pool.query(`${BATCH_SELECT} WHERE b.batch_uid = ? LIMIT 1`, [id]);
      return mapBatch(rows[0]);
    },

    /**
     * Counter patch. `patch.resolvedCount` is accepted and deliberately NOT written: the schema has no
     * `resolved_count`, and the count is derived on read from the staging rows themselves.
     */
    async updateBatchCounters(id, patch) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches
            SET rows_read = ?, rows_inserted = ?, rows_duplicate = ?, rows_unmapped = ?, updated_at = ?
          WHERE batch_uid = ?`,
        [
          patch.rowCount ?? 0,
          patch.insertedCount ?? 0,
          patch.duplicateCount ?? 0,
          patch.unmappedCount ?? 0,
          now,
          id,
        ],
      );
      return this.findBatch(id);
    },

    async commitBatch(id) {
      const now = new Date();
      await pool.query(
        `UPDATE facescan_import_batches SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE batch_uid = ?`,
        [now, now, id],
      );
      return this.findBatch(id);
    },

    async findByIdempotencyKey(idempotencyKey) {
      const [rows] = await pool.query(`${RAW_SELECT} WHERE r.source_event_key = ? LIMIT 1`, [idempotencyKey]);
      return mapRawRow(rows[0]);
    },

    async insertRawRow(input) {
      const now = new Date();
      // sensor_id / verify_code / work_code are HIP columns with no producer in this path yet; they stay NULL
      // rather than being filled with a placeholder.
      const [result] = await pool.query(
        `INSERT INTO staging_facescan_raw (
           source_system, source_event_key, facescan_id, check_time, check_type, employee_uid,
           resolution_status, import_batch_uid, raw_payload, imported_at, resolved_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sourceSystem || 'facescan_db',
          input.idempotencyKey,
          input.facescanId,
          input.scanDatetime,
          input.scanType ?? null,
          input.employeeUid ?? null,
          input.resolutionStatus || 'unmapped',
          input.batchId,
          input.payloadJson ? JSON.stringify(input.payloadJson) : null,
          now,
          input.resolvedAt ?? null,
          now,
        ],
      );
      const [rows] = await pool.query(`${RAW_SELECT} WHERE r.id = ? LIMIT 1`, [result.insertId]);
      return mapRawRow(rows[0]);
    },

    async listUnmapped({ batchId } = {}) {
      const params = [];
      let clause = '';
      if (batchId) {
        clause = ' AND r.import_batch_uid = ?';
        params.push(batchId);
      }
      const [rows] = await pool.query(
        `${RAW_SELECT} WHERE r.resolution_status = 'unmapped'${clause} ORDER BY r.id`,
        params,
      );
      return rows.map((row) => mapRawRow(row));
    },

    async resolveRow(id, { employeeUid, resolutionStatus }) {
      const now = new Date();
      await pool.query(
        `UPDATE staging_facescan_raw
            SET employee_uid = ?, resolution_status = ?, resolved_at = ?
          WHERE id = ? AND resolution_status = 'unmapped'`,
        [employeeUid, resolutionStatus, now, id],
      );
      const [rows] = await pool.query(`${RAW_SELECT} WHERE r.id = ? LIMIT 1`, [id]);
      return mapRawRow(rows[0]);
    },
  };
}

module.exports = { createFacescanRawMariaDbRepository };
