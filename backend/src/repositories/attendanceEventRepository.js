/**
 * Fixture seam for `attendance_events` (migration 016).
 *
 * The table exists on main and nothing in the repository wrote it: raw FaceScan rows stop at
 * `staging_facescan_raw` and daily attendance had no writer either. This repository promotes a
 * resolved staging row into a normalized event, and reads back the day's events.
 */

function createAttendanceEventRepository(initial = []) {
  let rows = initial.map((row) => ({ ...row }));

  const sameSourceEvent = (a, b) => (
    a.sourceSystem === b.sourceSystem && a.sourceEventKey === b.sourceEventKey
  );

  return {
    /** Only rows the identifier chain actually resolved — an unmapped scan is not attendance. */
    async findResolvedStagingForDay(employeeUid, date) {
      const staging = this.stagingRows || [];
      return staging
        .filter((row) => (
          row.employeeUid === employeeUid
          && row.resolutionStatus === 'resolved'
          && String(row.checkTime).slice(0, 10) === date
        ))
        .sort((a, b) => String(a.checkTime).localeCompare(String(b.checkTime)));
    },

    /** Fixture twin of the MariaDB method: resolved staging days (the fixture has no daily table to subtract). */
    async listUnderivedResolvedDays(employeeUid) {
      const days = new Set((this.stagingRows || [])
        .filter((row) => row.employeeUid === employeeUid && row.resolutionStatus === 'resolved')
        .map((row) => String(row.checkTime).slice(0, 10)));
      return [...days].sort();
    },

    /** Test helper: seed resolved staging rows without running the ingest service. */
    seedResolvedStaging(stagingRows) {
      this.stagingRows = stagingRows.map((row) => ({
        resolutionStatus: 'resolved',
        sourceSystem: 'facescan_db',
        ...row,
      }));
      return this.stagingRows.length;
    },

    /**
     * Idempotent on both unique keys in 016 — a replay of the same staging row, or of the same
     * (source_system, source_event_key) pair, is a no-op rather than a duplicate.
     */
    async insertEvent(row) {
      const duplicate = rows.find((existing) => (
        existing.stagingFacescanRawId === row.stagingFacescanRawId || sameSourceEvent(existing, row)
      ));
      if (duplicate) return duplicate;
      const stored = { ...row };
      rows = [...rows, stored];
      return stored;
    },

    async findDay(employeeUid, date) {
      return rows
        .filter((row) => row.employeeUid === employeeUid && String(row.eventTime).slice(0, 10) === date)
        .sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)));
    },

    async count() {
      return rows.length;
    },
  };
}

module.exports = { createAttendanceEventRepository };
