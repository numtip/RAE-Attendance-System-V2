const { randomUUID } = require('node:crypto');

function createFixtureFacescanIngestionRepository() {
  const batches = new Map();
  const eventsByKey = new Map();
  const eventsById = new Map();
  const usersByKey = new Map();
  let nextEventId = 1;

  return {
    async createBatch(input) {
      const batchUid = input.batchUid || randomUUID();
      const now = new Date().toISOString();
      const batch = {
        batchUid,
        sourceSystem: input.sourceSystem,
        sourceType: input.sourceType,
        sourceReference: input.sourceReference ?? null,
        windowFrom: input.windowFrom ?? null,
        windowTo: input.windowTo ?? null,
        status: 'open',
        rowsRead: 0,
        rowsInserted: 0,
        rowsDuplicate: 0,
        rowsUnmapped: 0,
        rowsFailed: 0,
        startedAt: now,
        completedAt: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
      };
      batches.set(batchUid, batch);
      return { ...batch };
    },

    async findBatch(batchUid) {
      const batch = batches.get(batchUid);
      return batch ? { ...batch } : null;
    },

    async updateBatch(batchUid, patch) {
      const batch = batches.get(batchUid);
      if (!batch) return null;
      Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
      return { ...batch };
    },

    async completeBatch(batchUid, patch = {}) {
      const batch = batches.get(batchUid);
      if (!batch) return null;
      batch.status = patch.status || 'completed';
      batch.completedAt = new Date().toISOString();
      batch.updatedAt = batch.completedAt;
      Object.assign(batch, patch);
      return { ...batch };
    },

    async findBySourceEventKey(sourceEventKey) {
      const row = eventsByKey.get(sourceEventKey);
      return row ? { ...row } : null;
    },

    async insertRawEvent(input) {
      const now = new Date().toISOString();
      const record = {
        id: nextEventId++,
        sourceSystem: input.sourceSystem,
        sourceEventKey: input.sourceEventKey,
        facescanId: input.facescanId,
        checkTime: input.checkTime,
        checkType: input.checkType,
        verifyCode: input.verifyCode,
        sensorId: input.sensorId,
        workCode: input.workCode,
        employeeUid: input.employeeUid ?? null,
        resolutionStatus: input.resolutionStatus,
        importBatchUid: input.importBatchUid,
        rawPayload: input.rawPayload ?? null,
        importedAt: now,
        resolvedAt: input.resolvedAt ?? null,
        createdAt: now,
      };
      eventsByKey.set(input.sourceEventKey, record);
      eventsById.set(record.id, record);
      return { ...record };
    },

    async listUnmapped({ importBatchUid } = {}) {
      return [...eventsById.values()]
        .filter((row) => row.resolutionStatus === 'unmapped'
          && (!importBatchUid || row.importBatchUid === importBatchUid))
        .map((row) => ({ ...row }));
    },

    async listResolved({ importBatchUid } = {}) {
      return [...eventsById.values()]
        .filter((row) => row.resolutionStatus === 'resolved'
          && row.employeeUid
          && (!importBatchUid || row.importBatchUid === importBatchUid))
        .map((row) => ({ ...row }));
    },

    async findRawById(id) {
      const row = eventsById.get(id);
      return row ? { ...row } : null;
    },

    async resolveEvent(id, { employeeUid, resolutionStatus }) {
      const row = eventsById.get(id);
      if (!row || row.resolutionStatus !== 'unmapped') return null;
      row.employeeUid = employeeUid;
      row.resolutionStatus = resolutionStatus;
      row.resolvedAt = new Date().toISOString();
      return { ...row };
    },

    async upsertUser(input) {
      const key = `${input.sourceSystem}:${input.facescanId}`;
      const now = new Date().toISOString();
      const existing = usersByKey.get(key);
      if (existing) {
        Object.assign(existing, input, { importedAt: now });
        return { ...existing, inserted: false };
      }
      const record = { ...input, importedAt: now, createdAt: now };
      usersByKey.set(key, record);
      return { ...record, inserted: true };
    },
  };
}

module.exports = { createFixtureFacescanIngestionRepository };
