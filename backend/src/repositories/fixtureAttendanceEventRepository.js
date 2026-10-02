const { randomUUID } = require('node:crypto');

function createFixtureAttendanceEventRepository() {
  const byStagingRawId = new Map();
  const bySourceEventKey = new Map();
  let nextId = 1;

  return {
    async findByStagingRawId(stagingFacescanRawId) {
      const row = byStagingRawId.get(stagingFacescanRawId);
      return row ? { ...row } : null;
    },

    async findBySourceEventKey(sourceSystem, sourceEventKey) {
      const row = bySourceEventKey.get(`${sourceSystem}:${sourceEventKey}`);
      return row ? { ...row } : null;
    },

    async insert(event) {
      if (byStagingRawId.has(event.stagingFacescanRawId)) {
        const dup = new Error('DUPLICATE_STAGING_RAW');
        dup.code = 'DUPLICATE_STAGING_RAW';
        throw dup;
      }
      const key = `${event.sourceSystem}:${event.sourceEventKey}`;
      if (bySourceEventKey.has(key)) {
        const dup = new Error('DUPLICATE_SOURCE_EVENT');
        dup.code = 'DUPLICATE_SOURCE_EVENT';
        throw dup;
      }
      const now = new Date().toISOString();
      const record = {
        id: nextId++,
        eventUid: event.eventUid || randomUUID(),
        ...event,
        normalizedAt: now,
        createdAt: now,
      };
      byStagingRawId.set(event.stagingFacescanRawId, record);
      bySourceEventKey.set(key, record);
      return { ...record };
    },

    async listByEmployee(employeeUid) {
      return [...byStagingRawId.values()]
        .filter((row) => row.employeeUid === employeeUid)
        .map((row) => ({ ...row }));
    },
  };
}

module.exports = { createFixtureAttendanceEventRepository };
