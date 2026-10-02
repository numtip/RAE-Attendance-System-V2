const { randomUUID } = require('node:crypto');

function createFixtureFacescanRawRepository() {
  const batches = new Map();
  const rowsByKey = new Map();
  const rowsById = new Map();
  let nextRowId = 1;

  return {
    async createBatch(input) {
      const id = input.id || randomUUID();
      const now = new Date().toISOString();
      const batch = {
        id,
        sourceSystem: input.sourceSystem || 'facescan_db',
        sourceLabel: input.sourceLabel ?? null,
        status: 'open',
        rowCount: 0,
        insertedCount: 0,
        duplicateCount: 0,
        unmappedCount: 0,
        resolvedCount: 0,
        startedAt: now,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      batches.set(id, batch);
      return { ...batch };
    },

    async findBatch(id) {
      const batch = batches.get(id);
      return batch ? { ...batch } : null;
    },

    async updateBatchCounters(id, patch) {
      const batch = batches.get(id);
      if (!batch) return null;
      Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
      return { ...batch };
    },

    async commitBatch(id) {
      const batch = batches.get(id);
      if (!batch) return null;
      batch.status = 'committed';
      batch.finishedAt = new Date().toISOString();
      batch.updatedAt = batch.finishedAt;
      return { ...batch };
    },

    async findByIdempotencyKey(idempotencyKey) {
      const row = rowsByKey.get(idempotencyKey);
      return row ? { ...row } : null;
    },

    async insertRawRow(input) {
      const now = new Date().toISOString();
      const record = {
        id: nextRowId++,
        batchId: input.batchId,
        facescanId: input.facescanId,
        scanDatetime: input.scanDatetime,
        scanType: input.scanType,
        payloadJson: input.payloadJson ?? null,
        idempotencyKey: input.idempotencyKey,
        employeeUid: input.employeeUid ?? null,
        resolutionStatus: input.resolutionStatus,
        resolvedAt: input.resolvedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rowsByKey.set(input.idempotencyKey, record);
      rowsById.set(record.id, record);
      return { ...record };
    },

    async listUnmapped({ batchId } = {}) {
      return [...rowsById.values()]
        .filter((row) => row.resolutionStatus === 'unmapped' && (!batchId || row.batchId === batchId))
        .map((row) => ({ ...row }));
    },

    async resolveRow(id, { employeeUid, resolutionStatus }) {
      const row = rowsById.get(id);
      if (!row) return null;
      row.employeeUid = employeeUid;
      row.resolutionStatus = resolutionStatus;
      row.resolvedAt = new Date().toISOString();
      row.updatedAt = row.resolvedAt;
      return { ...row };
    },
  };
}

module.exports = { createFixtureFacescanRawRepository };
