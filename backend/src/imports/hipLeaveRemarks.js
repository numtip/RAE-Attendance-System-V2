const { TextDecoder } = require('node:util');
const { parseCsv } = require('./facescanCsvExport');

/**
 * Recover leave from the `Remark [n]` column of a monthly HIP daily report.
 *
 * Rules (owner-approved, 2026-11-19). A leave remark is กิจ / ป่วย / พักผ่อน:
 *   leave remark + check-in only   -> candidate afternoon leave  (PM, 0.5)
 *   leave remark + check-out only  -> candidate morning leave    (AM, 0.5)
 *   leave remark + no scan         -> candidate full-day leave   (FULL, 1.0)
 *   ไม่สแกนเข้า / ไม่สแกนออก without a leave remark -> a missing punch, NOT leave
 *
 * These are HIP-derived classifications, not proof of HR approval. Anything contradictory or ambiguous
 * is returned as `needs_review` (never counted in a total):
 *   both_scans_present        leave remark but both scans exist (hourly leave? a mistaken remark?)
 *   scan_contradicts_remark   e.g. check-in only AND a "no check-in" remark
 *   scan_time_implausible     check-in only at/after 12:00, or check-out only before 12:00
 *   non_working_day           HIP marks a day off, it is a weekend (when HIP gave no day kind), or it is a holiday
 *   multiple_leave_types      two different leave words on one day
 *   conflicts_with_absent_flag / conflicts_with_official_duty   ขาดงาน / ไปราชการ on the same day
 *   duplicate_source_conflict the same person-day appears twice with different classifications
 *
 * The remark cell is not a single column: extra remarks are comma-separated and spill into following
 * fields, so everything from the first Remark column to the end of the row is read.
 * Free text is never kept — only the normalised leave type — because a remark can carry health detail.
 */

const LEAVE_WORDS = [['กิจ', 'personal'], ['ป่วย', 'sick'], ['พักผ่อน', 'vacation']];
const NO_IN = 'ไม่สแกนเข้า';
const NO_OUT = 'ไม่สแกนออก';
const ABSENT_FLAG = 'ขาดงาน';
const OFFICIAL_DUTY = 'ไปราชการ';
const DAY_OFF = 'วันหยุด';
const HOLIDAY_SHARE = 0.8;

class HipLeaveFileError extends Error {}

function leaveTypeOf(token) {
  for (const [word, type] of LEAVE_WORDS) if (token.includes(word)) return type;
  return null;
}

function columnKey(header) {
  return header.replace(/\s*[[{]\d+[\]}]/g, '').trim();
}

function parseThaiDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[3]) - 543;
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isWeekend(iso) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Text -> rows. One bad line refuses the file: a silently skipped row would be silently missing leave. */
function parseHipRemarkRows(text) {
  const cells = parseCsv(text);
  if (cells.length === 0) throw new HipLeaveFileError('empty file');
  const header = cells[0].cells ? cells[0].cells : cells[0];
  const names = header.map((cell) => columnKey(String(cell)));
  const at = (name) => names.indexOf(name);
  const idx = {
    machine: at('รหัสที่เครื่อง'), date: at('วัน/เวลา'), kind: at('สถานะ'),
    checkIn: at('เข้า'), checkOut: at('ออก'), remark: at('Remark'),
  };
  if (idx.machine < 0 || idx.date < 0 || idx.remark < 0 || idx.checkIn < 0 || idx.checkOut < 0) {
    throw new HipLeaveFileError('not a HIP daily report: a required column is missing');
  }
  const rows = [];
  for (const entry of cells.slice(1)) {
    const row = entry.cells ? entry.cells : entry;
    const line = entry.line ?? rows.length + 2;
    if (row.every((cell) => String(cell).trim() === '')) continue;
    const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : '');
    const date = parseThaiDate(cell(idx.date));
    if (!cell(idx.machine) || !date) throw new HipLeaveFileError(`line ${line}: missing machine code or an invalid date`);
    rows.push({
      line,
      machineId: cell(idx.machine),
      date,
      kind: idx.kind >= 0 ? cell(idx.kind) : '',
      checkIn: cell(idx.checkIn),
      checkOut: cell(idx.checkOut),
      remarks: row.slice(idx.remark).map((value) => String(value).trim()).filter(Boolean),
    });
  }
  return rows;
}

/** Dates on which almost everyone carries the same non-leave remark are holidays HIP wrote into Remark. */
function holidayDatesOf(rows) {
  const people = new Map();
  const shared = new Map();
  for (const row of rows) {
    people.set(row.date, (people.get(row.date) || new Set()).add(row.machineId));
    for (const token of new Set(row.remarks)) {
      if (leaveTypeOf(token) || ['สาย', NO_IN, NO_OUT, ABSENT_FLAG, OFFICIAL_DUTY, 'ออกก่อน'].includes(token)) continue;
      const key = `${row.date}|${token}`;
      shared.set(key, (shared.get(key) || 0) + 1);
    }
  }
  const dates = new Set();
  for (const [key, count] of shared) {
    const date = key.split('|')[0];
    if (count >= Math.max(5, HOLIDAY_SHARE * people.get(date).size)) dates.add(date);
  }
  return dates;
}

function classifyLeaveRow(row, { holidayDates = new Set() } = {}) {
  const types = new Set(row.remarks.map(leaveTypeOf).filter(Boolean));
  if (types.size === 0) return null;
  const reasons = [];
  if (types.size > 1) reasons.push('multiple_leave_types');
  if (row.remarks.some((token) => token.includes(ABSENT_FLAG))) reasons.push('conflicts_with_absent_flag');
  if (row.remarks.some((token) => token.includes(OFFICIAL_DUTY))) reasons.push('conflicts_with_official_duty');
  const off = row.kind === DAY_OFF || holidayDates.has(row.date) || (row.kind === '' && isWeekend(row.date));
  if (off) reasons.push('non_working_day');

  const hasIn = row.checkIn !== '';
  const hasOut = row.checkOut !== '';
  const hour = (value) => Number(value.split(':')[0]);
  let part;
  if (hasIn && hasOut) {
    reasons.push('both_scans_present');
  } else if (hasIn) {
    if (row.remarks.includes(NO_IN)) reasons.push('scan_contradicts_remark');
    if (hour(row.checkIn) >= 12) reasons.push('scan_time_implausible');
    part = 'PM';
  } else if (hasOut) {
    if (row.remarks.includes(NO_OUT)) reasons.push('scan_contradicts_remark');
    if (hour(row.checkOut) < 12) reasons.push('scan_time_implausible');
    part = 'AM';
  } else {
    part = 'FULL';
  }

  const leaveType = [...types][0];
  if (reasons.length > 0) {
    return { leaveType, dayPart: 'UNKNOWN', dayFraction: null, reviewStatus: 'needs_review', reviewReason: reasons.join(',') };
  }
  return { leaveType, dayPart: part, dayFraction: part === 'FULL' ? 1.0 : 0.5, reviewStatus: 'candidate', reviewReason: null };
}

/**
 * One file -> everything the importer and the audit need, counts and records only.
 * `period` is the single YYYY-MM the file's dates fall in (a mixed-month file is refused).
 */
function analyzeHipLeaveFile(text) {
  const rows = parseHipRemarkRows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const months = new Set(rows.map((row) => row.date.slice(0, 7)));
  if (months.size !== 1) throw new HipLeaveFileError('a monthly file must cover exactly one month');
  const holidayDates = holidayDatesOf(rows);

  const stats = {
    rowsScanned: rows.length,
    machines: new Set(rows.map((row) => row.machineId)).size,
    remarkRows: rows.filter((row) => row.remarks.length > 0).length,
    multiRemarkRows: rows.filter((row) => row.remarks.length > 1).length,
    missingPunchOnly: 0,
    absentFlagged: 0,
    officialDuty: 0,
    holidayDates: holidayDates.size,
  };
  const records = new Map();
  for (const row of rows) {
    const verdict = classifyLeaveRow(row, { holidayDates });
    if (!verdict) {
      if (row.remarks.some((token) => token === NO_IN || token === NO_OUT)) stats.missingPunchOnly += 1;
    }
    if (row.remarks.some((token) => token.includes(ABSENT_FLAG))) stats.absentFlagged += 1;
    if (row.remarks.some((token) => token.includes(OFFICIAL_DUTY))) stats.officialDuty += 1;
    if (!verdict) continue;
    const key = `${row.machineId}|${row.date}`;
    const record = { ...verdict, machineId: row.machineId, date: row.date, line: row.line };
    const earlier = records.get(key);
    if (earlier && (earlier.dayPart !== record.dayPart || earlier.leaveType !== record.leaveType)) {
      records.set(key, { ...earlier, dayPart: 'UNKNOWN', dayFraction: null, reviewStatus: 'needs_review', reviewReason: 'duplicate_source_conflict' });
    } else if (!earlier) {
      records.set(key, record);
    }
  }
  return { period: [...months][0], stats, records: [...records.values()] };
}

/** UTF-8, else Windows-874 (the Thai code page of the older HIP exports). Reported, not silent. */
function decodeHipFile(buffer) {
  const utf8 = Buffer.from(buffer).toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  return { text: new TextDecoder('windows-874').decode(buffer), encoding: 'windows-874' };
}

module.exports = {
  decodeHipFile,
  HipLeaveFileError, analyzeHipLeaveFile, classifyLeaveRow, parseHipRemarkRows, parseThaiDate, leaveTypeOf,
};
