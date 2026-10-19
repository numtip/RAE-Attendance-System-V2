const PERIOD_START = '2025-10-01';
const PERIOD_END = '2026-09-30';
const GAP_CODES = ['1013', '1020', '1021', '3015'];

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function inPeriod(iso) {
  return iso >= PERIOD_START && iso <= PERIOD_END;
}

function leaveType(label) {
  if (label === 'ลากิจ') return 'personal';
  if (label === 'ลาป่วย') return 'sick';
  if (label === 'ไปราชการ') return 'other';
  return null;
}

function minutesFromHms(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function wallToIso(date, time) {
  if (!time) return null;
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return null;
  const local = new Date(`${date}T${match[1]}:${match[2]}:00+07:00`);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

function buildFy2569Plan({ people, events, leave, review, summary }) {
  const byCode = new Map();
  const duplicateCodes = [];
  for (const person of people) {
    const code = norm(person.code);
    const name = norm(person.name);
    if (!code || !name) continue;
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, person);
      continue;
    }
    if (norm(existing.name) !== name) duplicateCodes.push(code);
  }
  const blocked = new Set(duplicateCodes);
  const gaps = {
    duplicateCodes: [...new Set(duplicateCodes)].sort(),
    unmatchedCodes: [],
    nameConflicts: 0,
    outsidePeriod: 0,
    withheldReview: 0,
    unknownLeaveType: 0,
    missingMonths: [],
    mismatchPersonMonths: 0,
    marchMismatchPersonMonths: 0,
    codeGaps: Object.fromEntries(GAP_CODES.map((code) => [code, { review: 0, mismatchMonths: 0 }])),
  };
  const unmatched = new Set();
  const attendance = new Map();
  const leaveRows = [];
  let late = 0;
  let early = 0;
  let sourceLate = 0;
  let sourceEarly = 0;
  let sourceLeave = 0;

  function acceptCode(code, eventName) {
    if (!byCode.has(code) || blocked.has(code)) {
      unmatched.add(code || '(blank)');
      return null;
    }
    const person = byCode.get(code);
    if (eventName && norm(eventName) !== norm(person.name)) {
      gaps.nameConflicts += 1;
      return null;
    }
    return person;
  }

  for (const event of events) {
    if (!inPeriod(event.date)) {
      gaps.outsidePeriod += 1;
      continue;
    }
    if (event.eventType === 'มาสาย') sourceLate += 1;
    else if (event.eventType === 'กลับก่อน') sourceEarly += 1;
    const person = acceptCode(norm(event.employeeId), event.employeeName);
    if (!person) continue;
    const key = `${norm(event.employeeId)}|${event.date}`;
    const row = attendance.get(key) || {
      employeeId: norm(event.employeeId),
      date: event.date,
      checkIn: null,
      checkOut: null,
      lateMinutes: 0,
      status: null,
    };
    if (event.eventType === 'มาสาย') {
      row.checkIn = wallToIso(event.date, event.actualTime);
      row.lateMinutes = minutesFromHms(event.deviation) || 0;
      row.status = 'late';
      late += 1;
    } else if (event.eventType === 'กลับก่อน') {
      row.checkOut = wallToIso(event.date, event.actualTime);
      if (row.status !== 'late') row.status = 'present';
      early += 1;
    } else {
      gaps.unknownLeaveType += 1;
      continue;
    }
    attendance.set(key, row);
  }

  for (const row of leave) {
    if (!inPeriod(row.date)) {
      gaps.outsidePeriod += 1;
      continue;
    }
    sourceLeave += 1;
    const person = acceptCode(norm(row.employeeId), row.employeeName);
    if (!person) continue;
    const mapped = leaveType(row.leaveType);
    if (!mapped) {
      gaps.unknownLeaveType += 1;
      continue;
    }
    leaveRows.push({
      employeeId: norm(row.employeeId),
      date: row.date,
      leaveType: mapped,
    });
  }

  for (const row of review) {
    gaps.withheldReview += 1;
    const code = norm(row.employeeId);
    if (gaps.codeGaps[code]) gaps.codeGaps[code].review += 1;
  }

  const months = new Set();
  for (const row of summary) {
    if (!inPeriod(`${row.year}-${String(row.month).padStart(2, '0')}-01`) && row.date) {
      continue;
    }
    months.add(`${row.year}-${row.month}`);
    const differs = Number(row.lateCount) !== Number(row.reportLate)
      || Number(row.earlyCount) !== Number(row.reportEarly);
    if (!differs) continue;
    gaps.mismatchPersonMonths += 1;
    if (Number(row.year) === 2026 && Number(row.month) === 3) gaps.marchMismatchPersonMonths += 1;
    const code = norm(row.employeeId);
    if (gaps.codeGaps[code]) gaps.codeGaps[code].mismatchMonths += 1;
  }
  const expectedMonths = [];
  for (let cursor = new Date('2025-10-01T00:00:00Z'); cursor <= new Date('2026-09-01T00:00:00Z'); cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    expectedMonths.push(`${cursor.getUTCFullYear()}-${cursor.getUTCMonth() + 1}`);
  }
  gaps.missingMonths = expectedMonths.filter((key) => !months.has(key));
  gaps.unmatchedCodes = [...unmatched].sort();

  return {
    period: { start: PERIOD_START, end: PERIOD_END },
    matchedEmployees: [...byCode.keys()].filter((code) => !blocked.has(code)).length,
    blockedEmployees: blocked.size,
    sourceLate,
    sourceEarly,
    sourceLeave,
    late,
    early,
    leave: leaveRows.length,
    attendanceDays: attendance.size,
    gaps,
    attendance: [...attendance.values()],
    leaveRows,
    people: [...byCode.values()].filter((person) => !blocked.has(norm(person.code))),
  };
}

module.exports = { buildFy2569Plan, PERIOD_START, PERIOD_END };
