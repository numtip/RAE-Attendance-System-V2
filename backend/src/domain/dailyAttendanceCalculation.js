/**
 * Versioned daily attendance calculation (Slice 2). PURE: no I/O, no database, no clock, no randomness.
 *
 * Provenance of the rules
 *   The day-evaluation semantics are ported from the donor attendance-core `attendance_core/engine.py`
 *   (`build_day_record` + `day_record_to_api_result`) and `attendance_core/policy.py`, which is the only
 *   place those values were ever defined. Three donor gaps are fixed here, each with a test:
 *     1. No overnight support. The donor compared bare clock values on a single date, so a post-midnight
 *        checkout was always reported as "left early".
 *     2. The holiday calendar lived in the CALLER. The donor's engine did not skip a holiday row, so a
 *        holiday carrying clock times could still be flagged late. Here the calendar is an input.
 *     3. The donor sorted by `int(employee_id)`, which throws on a non-numeric code. We never sort by it.
 *
 * The honesty rule
 *   Nothing here invents a policy. If no APPROVED rule version covers the date the result is
 *   `pending_policy` and NO late/early/work number is produced. If the scans cannot be interpreted the
 *   result is `insufficient_data`. Only a `calculated` result carries lateness conclusions. This is why
 *   `status` may be 'pending': it is better to say "not evaluated" than to assert present or absent.
 */
const { wallDateOnly } = require('../utils/bangkokTime');
const { HttpError } = require('../utils/httpError');

const COMPUTATION_STATUS = Object.freeze([
  'calculated',
  'no_data',
  'insufficient_data',
  'pending_policy',
  'failed',
]);

const DAY_CLASSIFICATION = Object.freeze(['workday', 'holiday', 'weekend']);

const DAY_STATUS = Object.freeze(['present', 'late', 'absent', 'leave', 'holiday', 'pending']);

/** The four values the pre-existing daily_attendance.leave_type ENUM accepts. */
const LEAVE_TYPES = Object.freeze(['sick', 'personal', 'vacation', 'other']);

const DEFAULT_WORK_DAYS = Object.freeze([1, 2, 3, 4, 5]);

/** A departure carried over from the next calendar day must be before noon to belong to this shift. */
const NOON_MINUTES = 12 * 60;

const LEAVE_MATCH_STATUSES = Object.freeze(['matched']);
const LEAVE_APPROVED_STATUSES = Object.freeze(['approved']);

// ---------------------------------------------------------------------------
// wall-clock helpers
// ---------------------------------------------------------------------------

/**
 * Split a stored naive Asia/Bangkok wall value into { date, time }.
 * Accepts a string ('YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS') or a Date (mysql2 returns one for a
 * DATETIME because the pool sets timezone 'Z', so toISOString is the lossless read - the same convention
 * documented on `wallDateOnly`). Returns nulls when the value cannot be read; the caller decides.
 */
function splitWallDateTime(value) {
  if (value == null || value === '') return { date: null, time: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { date: null, time: null };
    const iso = value.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }
  const text = String(value).trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return { date: null, time: null };
  const date = wallDateOnly(text);
  const timePart = text.length >= 19 ? text.slice(11, 19) : null;
  return { date, time: timePart && /^\d{2}:\d{2}:\d{2}$/.test(timePart) ? timePart : null };
}

/** 'HH:MM:SS' -> minutes since midnight. Null for anything unreadable (never a silent 0). */
function timeToMinutes(hhmmss) {
  if (hhmmss == null) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmmss).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** ISO-8601 day number (1=Monday .. 7=Sunday) for a 'YYYY-MM-DD' string, computed in UTC. */
function isoDayNumber(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  const weekday = probe.getUTCDay(); // 0=Sunday .. 6=Saturday
  return weekday === 0 ? 7 : weekday;
}

/** Next calendar day for an ISO date, or null. */
function nextIsoDate(isoDate) {
  const stamp = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(stamp)) return null;
  return new Date(stamp + 86_400_000).toISOString().slice(0, 10);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// input normalisation
// ---------------------------------------------------------------------------

function normalizeWorkDays(value) {
  if (value == null) return null;
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const days = list
    .map((day) => (typeof day === 'number' ? day : Number(String(day).trim())))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return days.length > 0 ? Array.from(new Set(days)).sort((a, b) => a - b) : null;
}

/**
 * Normalize the scans for one employee-day.
 * Events already carry the employee they were attributed to AT INGEST TIME, through the effective-dated
 * identity mapping. The engine therefore NEVER re-resolves identity: it aggregates what was attributed, so
 * a historical recalculation keeps the ownership that was true when the scan was imported. An event that
 * belongs to someone else, or to nobody, is excluded and reported - it is never silently re-attributed.
 */
function normalizeEvents(events, employeeUid) {
  const list = Array.isArray(events) ? events : [];
  const accepted = [];
  const foreignEmployeeUids = new Set();
  let unsignedCount = 0;
  let unreadableCount = 0;

  for (const event of list) {
    if (!event) {
      unreadableCount += 1;
      continue;
    }
    if (event.employeeUid == null) {
      unsignedCount += 1;
      continue;
    }
    if (employeeUid != null && event.employeeUid !== employeeUid) {
      foreignEmployeeUids.add(event.employeeUid);
      continue;
    }
    const { date, time } = splitWallDateTime(event.eventTime);
    if (!date || !time) {
      unreadableCount += 1;
      continue;
    }
    accepted.push({
      id: event.id ?? null,
      eventDate: date,
      wallTime: time,
      minutes: timeToMinutes(time),
      checkType: event.checkType ?? null,
      sourceSystem: event.sourceSystem ?? null,
    });
  }

  accepted.sort((a, b) => {
    // Order by FULL datetime, not by time-of-day: a departure after midnight has a smaller minute value
    // than the arrival that preceded it, so sorting on minutes alone would swap the pair.
    const left = `${a.eventDate} ${a.wallTime}`;
    const right = `${b.eventDate} ${b.wallTime}`;
    if (left !== right) return left < right ? -1 : 1;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  return {
    accepted,
    foreignEmployeeUids: Array.from(foreignEmployeeUids).sort(),
    unsignedCount,
    unreadableCount,
  };
}

/**
 * Collapse scans that are identical to the second, then pick the first arrival and the last departure.
 * A duplicate scan is a normal device artefact, not an error: it is counted, and the count travels into
 * the reconciliation payload so a reviewer can see why the event count is larger than the pair used.
 */
function collapseScans(accepted) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const event of accepted) {
    const key = `${event.wallTime}|${event.checkType || ''}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(event);
  }
  return { unique, duplicates };
}

/** Verified leave facts only: approved, matched, and covering the date. Anything else is a proposal. */
function findVerifiedLeave(leaveFacts, date) {
  const list = Array.isArray(leaveFacts) ? leaveFacts : [];
  const candidates = list.filter((fact) => {
    if (!fact) return false;
    const status = String(fact.status ?? '').trim().toLowerCase();
    const matchStatus = String(fact.matchStatus ?? fact.match_status ?? 'matched').trim().toLowerCase();
    if (!LEAVE_APPROVED_STATUSES.includes(status)) return false;
    if (!LEAVE_MATCH_STATUSES.includes(matchStatus)) return false;
    const from = String(fact.startDate ?? fact.start_date ?? '').slice(0, 10);
    const to = String(fact.endDate ?? fact.end_date ?? from).slice(0, 10);
    if (!from) return false;
    return from <= date && date <= to;
  });
  if (candidates.length === 0) return { leave: null, candidateCount: 0, conflictingTypes: [] };
  candidates.sort((a, b) => String(a.leaveId ?? '').localeCompare(String(b.leaveId ?? '')));
  const leave = candidates[0];
  const rawType = String(leave.leaveType ?? leave.leave_type ?? '').trim().toLowerCase();
  return {
    leave: {
      leaveId: leave.leaveId ?? leave.leave_id ?? null,
      // Only the four ENUM values may be stored. An unmappable type is reported, never coerced.
      leaveType: LEAVE_TYPES.includes(rawType) ? rawType : null,
      rawType: rawType || null,
    },
    candidateCount: candidates.length,
    conflictingTypes: Array.from(new Set(candidates.map((c) => String(c.leaveType ?? c.leave_type ?? '').toLowerCase()))).sort(),
  };
}

// ---------------------------------------------------------------------------
// the calculation
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.employeeUid
 * @param {string} input.date                'YYYY-MM-DD'
 * @param {Array}  input.events              normalized attendance_events for this employee-day
 * @param {object|null} input.rule           an APPROVED attendance_rule_version, or null
 * @param {object|null} input.schedule       an APPROVED attendance_schedule, or null
 * @param {object|null} input.holiday        an APPROVED holiday for this date, or null
 * @param {Array}  input.leaveFacts          employee_leave rows (verified ones are used)
 * @param {object} [input.options]
 * @returns {object} the daily_attendance row body (see the repositories' upsertDay contract)
 */
function calculateDailyAttendance(input = {}) {
  const employeeUid = input.employeeUid ?? null;
  const date = String(input.date ?? '').slice(0, 10);
  const options = input.options || {};
  const sourceSystem = options.sourceSystem ?? null;

  const reconciliation = {
    ruleVersionCode: input.rule?.ruleVersionCode ?? null,
    ruleStatus: input.rule?.status ?? null,
    scheduleCode: input.schedule?.scheduleCode ?? null,
    holiday: input.holiday
      ? { name: input.holiday.name ?? null, scope: input.holiday.scope ?? null }
      : null,
  };
  const notes = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isoDayNumber(date) == null) {
    throw new HttpError(400, 'DAILY_CALC_INVALID_DATE', 'date must be a real ISO date (YYYY-MM-DD)');
  }

  const { accepted, foreignEmployeeUids, unsignedCount, unreadableCount } = normalizeEvents(input.events, employeeUid);
  const { unique, duplicates } = collapseScans(accepted);
  const { leave, candidateCount, conflictingTypes } = findVerifiedLeave(input.leaveFacts, date);

  // Partition by calendar day. A shift that STARTS on this date may legitimately END on the next one, so
  // the next day's early events are a candidate departure. Events on the previous day are deliberately NOT
  // pulled in: the previous day's own row is where that shift is evaluated, which keeps exactly one row per
  // shift and avoids counting a night shift twice.
  const nextDate = nextIsoDate(date);
  const onDateEvents = unique.filter((event) => event.eventDate === date);
  const nextDayEvents = nextDate ? unique.filter((event) => event.eventDate === nextDate) : [];
  const offDateEvents = unique.filter(
    (event) => event.eventDate !== date && event.eventDate !== nextDate,
  );

  reconciliation.totalEventCount = Array.isArray(input.events) ? input.events.length : 0;
  reconciliation.usableEventCount = onDateEvents.length;
  reconciliation.duplicateScanCount = duplicates;
  if (nextDayEvents.length > 0) reconciliation.nextDayEventCount = nextDayEvents.length;
  if (offDateEvents.length > 0) {
    reconciliation.offDateEventCount = offDateEvents.length;
    reconciliation.offDateEventsExcluded = true;
  }
  if (unsignedCount > 0) reconciliation.unattributedEventCount = unsignedCount;
  if (unreadableCount > 0) reconciliation.unreadableEventCount = unreadableCount;
  if (foreignEmployeeUids.length > 0) {
    // Never disclose whose scans they were: the count and a flag are enough for a reviewer.
    reconciliation.foreignEventCount = foreignEmployeeUids.length;
    reconciliation.foreignEventsExcluded = true;
  }
  if (candidateCount > 1) {
    reconciliation.leaveFactCandidates = candidateCount;
    reconciliation.leaveFactAmbiguous = conflictingTypes.length > 1;
  }

  const sourceEventIds = onDateEvents.map((event) => event.id).filter((id) => Number.isInteger(id));
  const firstEventAt = onDateEvents.length > 0 ? `${onDateEvents[0].eventDate} ${onDateEvents[0].wallTime}` : null;
  const lastEventAt = onDateEvents.length > 0
    ? `${onDateEvents[onDateEvents.length - 1].eventDate} ${onDateEvents[onDateEvents.length - 1].wallTime}`
    : null;

  // Provenance: prefer the source the caller declared; otherwise derive it from the scans themselves. A
  // hardcoded default would be a false claim about where the data came from.
  const sourceSystems = Array.from(new Set(unique.map((event) => event.sourceSystem).filter(Boolean))).sort();
  if (sourceSystems.length > 1) reconciliation.sourceSystems = sourceSystems;
  const derivedSourceSystem = sourceSystems.length === 1 ? sourceSystems[0] : null;

  const base = {
    employeeUid,
    date,
    checkIn: null,
    checkOut: null,
    isLate: false,
    lateMinutes: 0,
    earlyMinutes: 0,
    workDuration: 0,
    isLeave: false,
    leaveType: null,
    status: 'pending',
    notes: null,
    sourceSystem: sourceSystem ?? derivedSourceSystem,
    ruleVersionCode: input.rule?.ruleVersionCode ?? null,
    scheduleCode: input.schedule?.scheduleCode ?? null,
    computationStatus: 'no_data',
    dayClassification: null,
    isOvernight: false,
    sourceEventCount: onDateEvents.length,
    firstEventAt,
    lastEventAt,
    calculatedAt: options.calculatedAt || null,
    reconciliationJson: reconciliation,
    sourceEventIds,
  };

  // --- 1. classify the day --------------------------------------------------
  // An approved holiday wins when the rule says to ignore holidays. A rule that does NOT ignore holidays
  // is an explicit instruction to treat holidays as working days, so classification stays 'workday'.
  const ignoreHolidays = input.rule ? input.rule.ignoreHolidays !== false : true;
  if (input.holiday && ignoreHolidays) {
    base.dayClassification = 'holiday';
    base.status = 'holiday';
    base.computationStatus = 'calculated';
    reconciliation.reason = 'approved_holiday';
    if (onDateEvents.length > 0) {
      // Scans on a holiday are recorded factually but never judged against work hours.
      base.checkIn = onDateEvents[0].wallTime;
      base.checkOut = onDateEvents[onDateEvents.length - 1].wallTime;
      notes.push('scans recorded on an approved holiday; no lateness evaluated');
      reconciliation.eventsOnNonWorkday = onDateEvents.length;
    }
    return finish(base, notes);
  }

  const workDays = normalizeWorkDays(input.schedule?.workDays ?? input.rule?.workDays);
  const dayNumber = isoDayNumber(date);
  const effectiveWorkDays = workDays || DEFAULT_WORK_DAYS;
  if (workDays == null) {
    // Recorded, not hidden: if the approved rule omitted the working week we fall back to Mon-Fri and say so.
    reconciliation.workDaysDefaulted = true;
  }
  if (!effectiveWorkDays.includes(dayNumber)) {
    base.dayClassification = 'weekend';
    base.status = 'holiday';
    base.computationStatus = 'calculated';
    reconciliation.reason = 'non_working_day';
    if (onDateEvents.length > 0) {
      base.checkIn = onDateEvents[0].wallTime;
      base.checkOut = onDateEvents[onDateEvents.length - 1].wallTime;
      notes.push('scans recorded on a non-working day; no lateness evaluated');
      reconciliation.eventsOnNonWorkday = onDateEvents.length;
    }
    return finish(base, notes);
  }
  base.dayClassification = 'workday';

  // --- 2. verified leave is a fact, independent of the rule -----------------
  if (leave) {
    base.isLeave = true;
    base.status = 'leave';
    base.leaveType = leave.leaveType;
    if (leave.leaveType == null) {
      // The leave exists but its type is not one the schema stores. Report it; do not coerce.
      reconciliation.leaveTypeUnmapped = leave.rawType;
      notes.push('leave type is outside the stored set; left null');
    }
    if (onDateEvents.length > 0) {
      // Someone was on leave and still scanned. Keep the scans, but do not assert lateness for a
      // leave day, matching the donor's LEAVE-first priority.
      base.checkIn = onDateEvents[0].wallTime;
      base.checkOut = onDateEvents[onDateEvents.length - 1].wallTime;
      reconciliation.eventsOnLeaveDay = onDateEvents.length;
      notes.push('scans recorded on a leave day; no lateness evaluated');
    }
    base.computationStatus = 'calculated';
    reconciliation.reason = 'verified_leave';
    if (input.rule == null) {
      // A verified leave fact does not need a rule, but say plainly that no rule backed this day.
      reconciliation.rulePendingForWorkHours = true;
    }
    return finish(base, notes);
  }

  // --- 3. from here on a rule is required to make any claim -----------------
  if (input.rule == null) {
    base.computationStatus = 'pending_policy';
    reconciliation.reason = 'no_approved_rule';
    reconciliation.rulePending = true;
    // Keep the observable facts, assert nothing about lateness.
    if (onDateEvents.length > 0) {
      base.checkIn = onDateEvents[0].wallTime;
      base.checkOut = onDateEvents[onDateEvents.length - 1].wallTime;
    }
    notes.push('no approved attendance rule covers this date; lateness not evaluated');
    return finish(base, notes);
  }

  // --- 4. interpret the scans ----------------------------------------------
  const overnightEnabled = (input.schedule?.overnightShift ?? input.rule.overnightShift) === true;

  // The departure of a shift that started today may be an early scan tomorrow. A scan tomorrow after noon
  // belongs to tomorrow's own row, so it is not pulled in here (that is what prevents double counting).
  const carryOverDepartures = overnightEnabled
    ? nextDayEvents.filter((event) => event.minutes != null && event.minutes < NOON_MINUTES)
    : [];
  if (!overnightEnabled && nextDayEvents.length > 0) {
    reconciliation.nextDayEventsIgnored = nextDayEvents.length;
  }
  const pairEvents = onDateEvents.concat(carryOverDepartures);

  if (pairEvents.length === 0) {
    // A rule confirms this is a working day, no leave and no scans: absence is a real conclusion.
    base.computationStatus = 'no_data';
    base.status = 'absent';
    reconciliation.reason = 'no_scans_on_working_day';
    return finish(base, notes);
  }

  if (pairEvents.length === 1) {
    // Only a departure or only an arrival: we cannot pair them, so we cannot judge the day.
    base.computationStatus = 'insufficient_data';
    base.status = 'pending';
    base.checkIn = pairEvents[0].wallTime;
    base.checkOut = pairEvents[0].wallTime;
    base.sourceEventCount = 1;
    base.sourceEventIds = [pairEvents[0].id].filter((id) => Number.isInteger(id));
    base.firstEventAt = `${pairEvents[0].eventDate} ${pairEvents[0].wallTime}`;
    base.lastEventAt = base.firstEventAt;
    reconciliation.reason = 'single_scan_only';
    notes.push('only one scan for the day; no in/out pair to evaluate');
    return finish(base, notes);
  }

  const first = pairEvents[0];
  const last = pairEvents[pairEvents.length - 1];
  base.checkIn = first.wallTime;
  base.checkOut = last.wallTime;
  base.sourceEventCount = pairEvents.length;
  base.sourceEventIds = pairEvents.map((event) => event.id).filter((id) => Number.isInteger(id));
  base.firstEventAt = `${first.eventDate} ${first.wallTime}`;
  base.lastEventAt = `${last.eventDate} ${last.wallTime}`;
  reconciliation.usableEventCount = pairEvents.length;

  const lateAfter = timeToMinutes(input.rule.lateAfter);
  const earlyBefore = timeToMinutes(input.rule.earlyBefore);
  const workStart = timeToMinutes(input.rule.workStart);
  const workEnd = timeToMinutes(input.rule.workEnd);

  if (lateAfter == null || earlyBefore == null || workStart == null || workEnd == null) {
    // A stored rule whose times cannot be read is a data defect, not a licence to guess.
    base.computationStatus = 'insufficient_data';
    base.status = 'pending';
    reconciliation.reason = 'rule_time_unreadable';
    notes.push('the approved rule has an unreadable time value; lateness not evaluated');
    return finish(base, notes);
  }

  const maxSpanMinutes = Number.isInteger(input.rule.maxShiftSpanMinutes)
    ? input.rule.maxShiftSpanMinutes
    : 960;

  const checkInMinutes = first.minutes;
  let checkOutMinutes = last.minutes;
  let earlyThreshold = earlyBefore;
  let isOvernightShift = false;

  if (last.eventDate !== date) {
    // The departure is on the following calendar day: shift the departure frame by 24h so the thresholds
    // are compared like-for-like.
    checkOutMinutes += 24 * 60;
    earlyThreshold += 24 * 60;
    base.isOvernight = true;
    isOvernightShift = true;
    reconciliation.overnightShiftApplied = true;
  } else if (checkOutMinutes < checkInMinutes) {
    // Same calendar day but inverted. With the pair ordered by full datetime this cannot arise from the
    // scans themselves, so it means two events share a timestamp with contradictory types.
    base.computationStatus = 'insufficient_data';
    base.status = 'pending';
    reconciliation.reason = 'checkout_before_checkin';
    notes.push('check-out and check-in are out of order within the same day');
    return finish(base, notes);
  }

  const spanMinutes = checkOutMinutes - checkInMinutes;
  if (spanMinutes > maxSpanMinutes) {
    // Most likely a mis-keyed timestamp. Refuse rather than record a 20-hour shift.
    base.computationStatus = 'insufficient_data';
    base.status = 'pending';
    reconciliation.reason = 'span_exceeds_max';
    reconciliation.spanMinutes = spanMinutes;
    reconciliation.maxShiftSpanMinutes = maxSpanMinutes;
    notes.push('the scan span exceeds the rule maximum; lateness not evaluated');
    return finish(base, notes);
  }

  if (isOvernightShift) {
    // Lateness and early departure are NOT well-defined for a night shift: no approved source defines an
    // overnight-relative threshold (the donor had no overnight support at all). The span IS a fact, so it is
    // recorded; the judgement is withheld and flagged for the policy owner instead of being invented.
    base.workDuration = round2(spanMinutes / 60);
    base.status = 'present';
    base.computationStatus = 'calculated';
    reconciliation.reason = 'calculated_from_scans';
    reconciliation.overnightLatenessPolicyMissing = true;
    notes.push('overnight shift: lateness and early departure are not evaluated because no approved rule defines them');
    base.reconciliationJson = reconciliation;
    return finish(base, notes);
  }

  if (checkInMinutes > lateAfter) {
    base.isLate = true;
    base.lateMinutes = checkInMinutes - lateAfter;
  }
  if (checkOutMinutes < earlyThreshold) {
    base.earlyMinutes = earlyThreshold - checkOutMinutes;
  }
  base.workDuration = round2(spanMinutes / 60);
  base.status = base.isLate ? 'late' : 'present';
  base.computationStatus = 'calculated';
  reconciliation.reason = 'calculated_from_scans';

  base.reconciliationJson = reconciliation;
  return finish(base, notes);
}

function finish(base, notes) {
  const cleanNotes = notes.filter(Boolean);
  base.notes = cleanNotes.length > 0 ? cleanNotes.join('; ') : null;
  return base;
}

module.exports = {
  COMPUTATION_STATUS,
  DAY_CLASSIFICATION,
  DAY_STATUS,
  LEAVE_TYPES,
  DEFAULT_WORK_DAYS,
  calculateDailyAttendance,
  // exported for reuse and for tests
  splitWallDateTime,
  timeToMinutes,
  isoDayNumber,
  nextIsoDate,
  normalizeWorkDays,
  normalizeEvents,
  collapseScans,
  findVerifiedLeave,
};
