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

    /**
     * Slice 2: scans for one employee over an inclusive date range, ordered by wall date+time.
     * Mirrors `DATE(event_time) BETWEEN ? AND ?` in the MariaDB twin; the fixture stores eventTime as a
     * naive wall string, so a lexical slice of the first 10 characters is the equivalent predicate.
     */
    async listForEmployeeRange({ employeeUid, from, to }) {
      return [...byStagingRawId.values()]
        .filter((row) => row.employeeUid === employeeUid)
        .filter((row) => {
          const day = String(row.eventTime ?? '').slice(0, 10);
          return day && day >= from && day <= to;
        })
        .sort((a, b) => (String(a.eventTime) < String(b.eventTime) ? -1
          : String(a.eventTime) > String(b.eventTime) ? 1
            : (a.id ?? 0) - (b.id ?? 0)))
        .map((row) => ({ ...row }));
    },

    /** Slice 2: distinct employees with any scan in the inclusive range. Sorted for a deterministic run. */
    async listEmployeeUidsWithEvents({ from, to }) {
      const uids = new Set();
      for (const row of byStagingRawId.values()) {
        const day = String(row.eventTime ?? '').slice(0, 10);
        if (row.employeeUid && day && day >= from && day <= to) uids.add(row.employeeUid);
      }
      return Array.from(uids).sort();
    },
  };
}

module.exports = { createFixtureAttendanceEventRepository };
