const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { createEmployeeIdentityService } = require('./employeeIdentityService');
const {
  buildIdempotencyKey,
  normalizeFacescanId,
  normalizeScanDatetime,
  normalizeScanType,
} = require('../domain/facescanRaw');

function createFacescanRawIngestionService({ repositories }) {
  const facescanRaw = repositories.facescanRaw;
  const identity = createEmployeeIdentityService({ repositories });

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

  return {
    async startBatch(input = {}) {
      const id = input.id || randomUUID();
      return facescanRaw.createBatch({
        id,
        sourceSystem: input.sourceSystem || 'facescan_db',
        sourceLabel: input.sourceLabel ?? null,
      });
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
      await facescanRaw.commitBatch(batchId);

      return {
        batch: updatedBatch,
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

module.exports = { createFacescanRawIngestionService };
