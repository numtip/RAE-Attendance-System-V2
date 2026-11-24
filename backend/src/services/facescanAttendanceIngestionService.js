const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { assertCanRecordDay } = require('./attendanceRecordService');
const { isCalendarDate } = require('../domain/attendanceRuleEngine');

/**
 * FaceScan raw -> attendance_events -> daily attendance.
 *
 * The chain had two finished halves and one missing step: scans were already ingested into
 * `staging_facescan_raw` with a resolved employee, the daily write path already evaluates AR-0001
 * and re-derives the month, and nothing promoted one into the other. This service is only the
 * promotion and the choice of two times; every rule, every column and the monthly summary belong
 * to `attendanceRecordService.recordDay`.
 */

function assertDate(date) {
  if (!isCalendarDate(date)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
}

/**
 * Event times come back as zone-less Bangkok wall clock (`2026-11-16T08:30:00`). `new Date()` on that
 * string uses the process timezone, which is UTC in the containers, so the stored first/last event
 * would land seven hours after the check-in written from the same scan. Pin the offset explicitly.
 */
function bangkokInstant(wallClock) {
  return new Date(`${String(wallClock).slice(0, 19)}+07:00`);
}

/**
 * Check-in is the first scan of the day, check-out the last, and a single distinct minute is an
 * arrival with no departure. `check_type` is deliberately ignored: the staging column is mostly
 * NULL and its unexpected values collapse to 'unknown', so a positional rule is the only one that
 * cannot contradict itself on this data.
 *
 * shortcut: events after midnight belong to the next date, so a night shift whose checkout lands at
 * 00:20 derives as a single-scan day. Upgrade when overnight shifts become real.
 */
function pickTimes(events) {
  const minutes = [...new Set(events.map((event) => String(event.eventTime).slice(11, 16)))].sort();
  return {
    checkIn: minutes[0] ?? null,
    checkOut: minutes.length > 1 ? minutes[minutes.length - 1] : null,
  };
}

function createFacescanAttendanceIngestionService({ repositories, recordService }) {
  return {
    async deriveDay(auth, employeeUid, date) {
      assertDate(date);

      // Scope is checked before the first insert: an out-of-scope caller must not be able to create
      // events as a side effect of being refused later.
      await assertCanRecordDay(auth, employeeUid, repositories);

      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');

      // A replay must never silently replace a person's manual correction with scan-derived times.
      const existing = (await repositories.attendance.findForEmployee(employeeUid))
        .find((row) => String(row.date).slice(0, 10) === date);
      if (existing && ['API', 'MANUAL_CORRECTION'].includes(existing.sourceSystem)) {
        throw new HttpError(409, 'MANUAL_ATTENDANCE_PROTECTED', 'A manual attendance correction needs review');
      }

      const staging = await repositories.attendanceEvents.findResolvedStagingForDay(employeeUid, date);
      if (staging.length === 0) {
        // A day with no resolved scan is not stored at all: no scans is `pending`/`no_data`, and
        // absence is an HR decision this service must not make on its behalf.
        throw new HttpError(
          404,
          'NO_FACESCAN_EVENTS',
          'No resolved facescan events for this employee on this date',
        );
      }

      const now = new Date();
      for (const row of staging) {
        await repositories.attendanceEvents.insertEvent({
          eventUid: randomUUID(),
          employeeUid,
          stagingFacescanRawId: row.id,
          importBatchUid: row.importBatchUid,
          sourceSystem: row.sourceSystem,
          sourceEventKey: row.sourceEventKey,
          facescanId: row.facescanId,
          eventTime: row.checkTime,
          checkType: row.checkType,
          verifyCode: row.verifyCode,
          sensorId: row.sensorId,
          workCode: row.workCode,
          normalizedAt: now,
          createdAt: now,
        });
      }

      const events = await repositories.attendanceEvents.findDay(employeeUid, date);
      const { checkIn, checkOut } = pickTimes(events);

      const recorded = await recordService.recordDay(
        auth,
        employeeUid,
        date,
        { checkIn, checkOut },
        {
          source: 'FACESCAN',
          sourceSystem: 'FACESCAN',
          eventCount: events.length,
          firstEventAt: bangkokInstant(events[0].eventTime),
          lastEventAt: bangkokInstant(events[events.length - 1].eventTime),
        },
      );

      return { ...recorded, checkIn, checkOut, eventCount: events.length };
    },
  };
}

module.exports = { createFacescanAttendanceIngestionService, pickTimes };
