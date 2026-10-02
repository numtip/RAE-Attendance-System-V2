const { HttpError } = require('../utils/httpError');
const {
  SOURCE_TYPE_FACESCAN_CHECKINOUT,
  TIMEZONE_BANGKOK,
} = require('../domain/attendanceEvent');

function mapRawToNormalizedInput(raw) {
  if (!raw.employeeUid) {
    return null;
  }
  return {
    employeeUid: raw.employeeUid,
    stagingFacescanRawId: raw.id,
    importBatchUid: raw.importBatchUid,
    sourceSystem: raw.sourceSystem,
    sourceEventKey: raw.sourceEventKey,
    sourceType: SOURCE_TYPE_FACESCAN_CHECKINOUT,
    facescanId: raw.facescanId,
    eventTime: raw.checkTime,
    checkType: raw.checkType,
    verifyCode: raw.verifyCode,
    sensorId: raw.sensorId,
    workCode: raw.workCode,
    timezoneLabel: TIMEZONE_BANGKOK,
  };
}

function createFacescanNormalizationService({ repositories }) {
  const facescan = repositories.facescanIngestion;
  const attendanceEvents = repositories.attendanceEvents;

  return {
    /**
     * Create attendance_events from resolved staging_facescan_raw rows (idempotent).
     * Skips unmapped rows. No late/early/work rules. Does not touch daily_attendance.
     */
    async normalizeResolved({ importBatchUid } = {}) {
      const raws = await facescan.listResolved({ importBatchUid });
      let created = 0;
      let skipped = 0;
      let duplicate = 0;
      const results = [];

      for (const raw of raws) {
        const existing = await attendanceEvents.findByStagingRawId(raw.id);
        if (existing) {
          duplicate += 1;
          results.push({ stagingFacescanRawId: raw.id, outcome: 'duplicate' });
          continue;
        }

        const payload = mapRawToNormalizedInput(raw);
        if (!payload) {
          skipped += 1;
          results.push({ stagingFacescanRawId: raw.id, outcome: 'skipped_unresolved' });
          continue;
        }

        try {
          const event = await attendanceEvents.insert(payload);
          created += 1;
          results.push({
            outcome: 'created',
            eventUid: event.eventUid,
            stagingFacescanRawId: raw.id,
            employeeUid: event.employeeUid,
          });
        } catch (error) {
          if (error.code === 'DUPLICATE_STAGING_RAW' || error.code === 'DUPLICATE_SOURCE_EVENT' || error.code === 'DUPLICATE_EVENT') {
            duplicate += 1;
            results.push({ stagingFacescanRawId: raw.id, outcome: 'duplicate' });
            continue;
          }
          throw error;
        }
      }

      return { created, skipped, duplicate, results };
    },

    async normalizeStagingRawId(stagingFacescanRawId) {
      if (!stagingFacescanRawId) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'stagingFacescanRawId is required');
      }
      const raw = await facescan.findRawById(stagingFacescanRawId);
      if (!raw) {
        throw new HttpError(404, 'RAW_EVENT_NOT_FOUND', 'Staging raw event not found');
      }
      if (raw.resolutionStatus !== 'resolved' || !raw.employeeUid) {
        throw new HttpError(409, 'RAW_NOT_RESOLVED', 'Staging row is not resolved with employee_uid');
      }
      const existing = await attendanceEvents.findByStagingRawId(raw.id);
      if (existing) {
        return { outcome: 'duplicate', event: existing };
      }
      const event = await attendanceEvents.insert(mapRawToNormalizedInput(raw));
      return { outcome: 'created', event };
    },
  };
}

module.exports = { createFacescanNormalizationService, mapRawToNormalizedInput };
