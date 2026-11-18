const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { createEmployeeIdentityService } = require('./employeeIdentityService');
const {
  buildIdempotencyKey,
  normalizeFacescanId,
  normalizeScanDatetime,
  normalizeScanType,
} = require('../domain/facescanRaw');
const { parseFacescanCsvExport, FacescanFileError } = require('../imports/facescanCsvExport');
const { parseHipDailyReport } = require('../imports/hipDailyReport');

const SOURCE_REFERENCE_MAX = 255; // facescan_import_batches.source_reference VARCHAR(255)

/**
 * File formats and the provenance each one stamps on its batch. `source_system` travels from the batch to
 * every staging row and attendance event, which is how report-derived times stay distinguishable from
 * original device punches downstream.
 */
const FILE_FORMATS = Object.freeze({
  canonical: { parse: parseFacescanCsvExport, sourceSystem: 'hip_csv_export' },
  hip_daily_report: { parse: parseHipDailyReport, sourceSystem: 'hip_daily_report' },
});

function parseFile(content, format) {
  const entry = FILE_FORMATS[format];
  if (!entry) {
    throw new HttpError(400, 'VALIDATION_ERROR', `unknown file format: ${format}`);
  }
  try {
    return { ...entry.parse(content), sourceSystem: entry.sourceSystem };
  } catch (error) {
    if (error instanceof FacescanFileError) {
      throw new HttpError(400, error.code, error.message, { issues: error.issues });
    }
    throw error;
  }
}

function dateSpan(rows) {
  const dates = rows.map((row) => row.scanDatetime.slice(0, 10)).sort();
  return { dateFrom: dates[0] ?? null, dateTo: dates[dates.length - 1] ?? null };
}

function createFacescanRawIngestionService({ repositories, nationalIdProtector = null }) {
  const facescanRaw = repositories.facescanRaw;
  const identity = createEmployeeIdentityService({ repositories, nationalIdProtector });

  async function resolveFacescanUid(facescanId) {
    try {
      return await identity.resolveUid('facescan_id', facescanId);
    } catch (error) {
      if (error.code === 'EMPLOYEE_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async function startBatch(input = {}) {
    const id = input.id || randomUUID();
    return facescanRaw.createBatch({
      id,
      sourceSystem: input.sourceSystem || 'facescan_db',
      sourceLabel: input.sourceLabel ?? null,
    });
  }

  return {
    startBatch,

    /**
     * HIP export file -> staging_facescan_raw, through the existing batch path.
     *
     * The whole file is validated before a batch exists, so a refused file leaves no trace and a
     * batch is never half-imported. Re-importing the same file yields only duplicates (the existing
     * idempotency key). Unknown facescan_ids are stored as `unmapped` — quarantined: the facescan
     * derivation reads only `resolved` rows, and `reResolveUnmapped` promotes them once an
     * employee_identifier is approved. Nothing here derives attendance.
     */
    async ingestFile(content, { sourceLabel = null, format = 'canonical' } = {}) {
      const parsed = parseFile(content, format);
      // The content hash makes the batch traceable to the exact file without storing the file.
      const reference = [sourceLabel, `sha256:${parsed.contentSha256}`].filter(Boolean).join(' ');
      const batch = await startBatch({
        sourceSystem: parsed.sourceSystem,
        sourceLabel: reference.slice(-SOURCE_REFERENCE_MAX),
      });
      const result = await this.ingestBatch(batch.id, parsed.rows);
      return {
        ...result,
        contentSha256: parsed.contentSha256,
        sourceSystem: parsed.sourceSystem,
        rows: parsed.rows,
        summary: parsed.summary ?? null,
      };
    },

    /**
     * Dry run of `ingestFile`: the same parse, idempotency key and identity resolution, and no write —
     * no batch, no staging row. Returns aggregates only (no facescan_id values).
     */
    async previewFile(content, { format = 'canonical' } = {}) {
      const parsed = parseFile(content, format);
      const codes = new Map();
      let alreadyImported = 0;
      let newResolved = 0;
      let newUnmapped = 0;
      for (const raw of parsed.rows) {
        const facescanId = normalizeFacescanId(raw.facescanId);
        const idempotencyKey = buildIdempotencyKey({
          facescanId,
          scanDatetime: normalizeScanDatetime(raw.scanDatetime),
          scanType: normalizeScanType(raw.scanType),
        });
        if (await facescanRaw.findByIdempotencyKey(idempotencyKey)) {
          alreadyImported += 1;
          continue;
        }
        if (!codes.has(facescanId)) codes.set(facescanId, await resolveFacescanUid(facescanId));
        if (codes.get(facescanId)) newResolved += 1;
        else newUnmapped += 1;
      }
      const resolvedCodes = [...codes.values()].filter(Boolean);
      return {
        format,
        sourceSystem: parsed.sourceSystem,
        contentSha256: parsed.contentSha256,
        summary: parsed.summary ?? null,
        scanRows: parsed.rows.length,
        ...dateSpan(parsed.rows),
        alreadyImported,
        newResolved,
        newUnmapped,
        distinctCodes: codes.size,
        unmappedCodes: codes.size - resolvedCodes.length,
        employees: new Set(resolvedCodes).size,
      };
    },

    async ingestBatch(batchId, rawRows) {
      const batch = await facescanRaw.findBatch(batchId);
      if (!batch) {
        throw new HttpError(404, 'BATCH_NOT_FOUND', 'Import batch not found');
      }
      if (batch.status !== 'open') {
        throw new HttpError(409, 'BATCH_NOT_OPEN', 'Import batch is not open');
      }
      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'rawRows must be a non-empty array');
      }

      let insertedCount = batch.insertedCount;
      let duplicateCount = batch.duplicateCount;
      let unmappedCount = batch.unmappedCount;
      let resolvedCount = batch.resolvedCount;
      const results = [];

      for (const raw of rawRows) {
        const facescanId = normalizeFacescanId(raw.facescanId ?? raw.facescan_id);
        const scanDatetime = normalizeScanDatetime(raw.scanDatetime ?? raw.scan_datetime);
        const scanType = normalizeScanType(raw.scanType ?? raw.scan_type);
        if (!facescanId || !scanDatetime) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'facescan_id and scan_datetime are required');
        }

        const idempotencyKey = buildIdempotencyKey({ facescanId, scanDatetime, scanType });
        const existing = await facescanRaw.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          duplicateCount += 1;
          results.push({
            idempotencyKey,
            resolutionStatus: 'duplicate',
            existingRowId: existing.id,
          });
          continue;
        }

        const employeeUid = await resolveFacescanUid(facescanId);
        const resolutionStatus = employeeUid ? 'resolved' : 'unmapped';
        const row = await facescanRaw.insertRawRow({
          batchId,
          // The row carries the batch's provenance; it used to default to 'facescan_db' regardless.
          sourceSystem: batch.sourceSystem,
          facescanId,
          scanDatetime,
          scanType,
          payloadJson: raw.payload ?? raw.payloadJson ?? null,
          idempotencyKey,
          employeeUid,
          resolutionStatus,
          resolvedAt: employeeUid ? new Date().toISOString() : null,
        });
        insertedCount += 1;
        if (employeeUid) {
          resolvedCount += 1;
        } else {
          unmappedCount += 1;
        }
        results.push({
          id: row.id,
          idempotencyKey,
          facescanId,
          resolutionStatus,
          employeeUid: employeeUid || undefined,
        });
      }

      const rowCount = batch.rowCount + rawRows.length;
      const updatedBatch = await facescanRaw.updateBatchCounters(batchId, {
        rowCount,
        insertedCount,
        duplicateCount,
        unmappedCount,
        resolvedCount,
      });
      // Return the batch as committed: the counters snapshot above still says 'open'.
      const committed = await facescanRaw.commitBatch(batchId);

      return {
        batch: committed || updatedBatch,
        results,
      };
    },

    async reResolveUnmapped({ batchId } = {}) {
      const rows = await facescanRaw.listUnmapped({ batchId });
      let resolved = 0;
      let stillUnmapped = 0;
      const updates = [];

      for (const row of rows) {
        const employeeUid = await resolveFacescanUid(row.facescanId);
        if (!employeeUid) {
          stillUnmapped += 1;
          continue;
        }
        const updated = await facescanRaw.resolveRow(row.id, {
          employeeUid,
          resolutionStatus: 'resolved',
        });
        if (updated && updated.resolutionStatus === 'resolved') {
          resolved += 1;
          updates.push({ id: updated.id, employeeUid: updated.employeeUid });
        }
      }

      if (batchId) {
        const batch = await facescanRaw.findBatch(batchId);
        if (batch) {
          await facescanRaw.updateBatchCounters(batchId, {
            rowCount: batch.rowCount,
            insertedCount: batch.insertedCount,
            duplicateCount: batch.duplicateCount,
            unmappedCount: Math.max(0, batch.unmappedCount - resolved),
            resolvedCount: batch.resolvedCount + resolved,
          });
        }
      }

      return { resolved, stillUnmapped, updates };
    },
  };
}

module.exports = { createFacescanRawIngestionService, FILE_FORMATS };
