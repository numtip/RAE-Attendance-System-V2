const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { createEmployeeIdentityService } = require('./employeeIdentityService');
const {
  SOURCE_SYSTEM_HIP,
  normalizeCheckinoutRow,
  buildSourceEventKey,
} = require('../domain/facescanIngestion');

function createFacescanIngestionService({ repositories }) {
  const store = repositories.facescanIngestion;
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
      const batchUid = input.batchUid || randomUUID();
      return store.createBatch({
        batchUid,
        sourceSystem: input.sourceSystem || SOURCE_SYSTEM_HIP,
        sourceType: input.sourceType || 'checkinout',
        sourceReference: input.sourceReference ?? null,
        windowFrom: input.windowFrom ?? null,
        windowTo: input.windowTo ?? null,
      });
    },

    async ingestCheckinoutBatch(batchUid, checkinoutRows, options = {}) {
      const batch = await store.findBatch(batchUid);
      if (!batch) {
        throw new HttpError(404, 'BATCH_NOT_FOUND', 'Import batch not found');
      }
      if (batch.status !== 'open') {
        throw new HttpError(409, 'BATCH_NOT_OPEN', 'Import batch is not open');
      }
      if (!Array.isArray(checkinoutRows) || checkinoutRows.length === 0) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'checkinoutRows must be a non-empty array');
      }

      const sourceSystem = options.sourceSystem || batch.sourceSystem || SOURCE_SYSTEM_HIP;
      let rowsRead = batch.rowsRead;
      let rowsInserted = batch.rowsInserted;
      let rowsDuplicate = batch.rowsDuplicate;
      let rowsUnmapped = batch.rowsUnmapped;
      let rowsFailed = batch.rowsFailed;
      const results = [];

      for (const sourceRow of checkinoutRows) {
        rowsRead += 1;
        const normalized = normalizeCheckinoutRow(sourceRow);
        if (normalized.invalidReason) {
          rowsFailed += 1;
          results.push({
            outcome: 'failed',
            reason: normalized.invalidReason,
          });
          continue;
        }

        const sourceEventKey = buildSourceEventKey(normalized);
        const existing = await store.findBySourceEventKey(sourceEventKey);
        if (existing) {
          rowsDuplicate += 1;
          results.push({
            outcome: 'duplicate',
            sourceEventKey,
            existingEventId: existing.id,
          });
          continue;
        }

        const employeeUid = await resolveFacescanUid(normalized.facescanId);
        const resolutionStatus = employeeUid ? 'resolved' : 'unmapped';
        const event = await store.insertRawEvent({
          sourceSystem,
          sourceEventKey,
          facescanId: normalized.facescanId,
          checkTime: normalized.checkTime,
          checkType: normalized.checkType,
          verifyCode: normalized.verifyCode,
          sensorId: normalized.sensorId,
          workCode: normalized.workCode,
          employeeUid,
          resolutionStatus,
          importBatchUid: batchUid,
          rawPayload: normalized.rawPayload,
          resolvedAt: employeeUid ? new Date().toISOString() : null,
        });
        rowsInserted += 1;
        if (employeeUid) {
          // resolved
        } else {
          rowsUnmapped += 1;
        }
        results.push({
          outcome: 'inserted',
          id: event.id,
          sourceEventKey,
          facescanId: normalized.facescanId,
          resolutionStatus,
          employeeUid: employeeUid || undefined,
        });
      }

      const updatedBatch = await store.completeBatch(batchUid, {
        status: 'completed',
        rowsRead,
        rowsInserted,
        rowsDuplicate,
        rowsUnmapped,
        rowsFailed,
      });

      return { batch: updatedBatch, results };
    },

    async reResolveUnmapped({ importBatchUid } = {}) {
      const rows = await store.listUnmapped({ importBatchUid });
      let resolved = 0;
      let stillUnmapped = 0;
      const updates = [];

      for (const row of rows) {
        const before = { ...row };
        const employeeUid = await resolveFacescanUid(row.facescanId);
        if (!employeeUid) {
          stillUnmapped += 1;
          continue;
        }
        const updated = await store.resolveEvent(row.id, {
          employeeUid,
          resolutionStatus: 'resolved',
        });
        if (updated) {
          resolved += 1;
          updates.push({
            id: updated.id,
            employeeUid: updated.employeeUid,
            facescanIdUnchanged: updated.facescanId === before.facescanId,
            checkTimeUnchanged: updated.checkTime === before.checkTime,
            sourceEventKeyUnchanged: updated.sourceEventKey === before.sourceEventKey,
          });
        }
      }

      if (importBatchUid) {
        const batch = await store.findBatch(importBatchUid);
        if (batch) {
          await store.updateBatch(importBatchUid, {
            rowsRead: batch.rowsRead,
            rowsInserted: batch.rowsInserted,
            rowsDuplicate: batch.rowsDuplicate,
            rowsUnmapped: Math.max(0, batch.rowsUnmapped - resolved),
            rowsFailed: batch.rowsFailed,
          });
        }
      }

      return { resolved, stillUnmapped, updates };
    },

    async ingestUserinfoRows(userinfoRows, options = {}) {
      if (!Array.isArray(userinfoRows)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'userinfoRows must be an array');
      }
      const sourceSystem = options.sourceSystem || SOURCE_SYSTEM_HIP;
      const results = [];
      for (const row of userinfoRows) {
        const facescanId = String(row.USERID ?? row.userId ?? row.facescan_id ?? '').trim();
        if (!facescanId) {
          results.push({ outcome: 'skipped', reason: 'missing_userid' });
          continue;
        }
        await store.upsertUser({
          facescanId,
          badgeNumber: row.Badgenumber ?? row.badgenumber ?? row.badge_number ?? null,
          displayName: row.Name ?? row.name ?? row.display_name ?? null,
          cardMetadata: row.Card ?? row.card ?? null,
          privilege: row.privilege ?? null,
          groupName: row.Grp ?? row.group_name ?? null,
          sourceSystem,
        });
        results.push({ outcome: 'upserted', facescanId });
      }
      return { results };
    },
  };
}

module.exports = { createFacescanIngestionService };
