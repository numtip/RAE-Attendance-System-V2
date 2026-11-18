const { createHash } = require('node:crypto');
const {
  decodeBuffer,
  parseCsv,
  parseScanDatetime,
  FacescanFileError,
  MAX_REPORTED_ISSUES,
  FACESCAN_ID_MAX,
} = require('./facescanCsvExport');

/**
 * HIP Premium Time daily report -> rawRows for `facescanRawIngestion.ingestBatch`.
 *
 * The vendor export seen on the host is a DAILY SUMMARY, not a punch log: one row per person-day with
 * `รหัสที่เครื่อง` (device code), `วัน/เวลา` (`DD/MM/BBBB`, Buddhist era) and numbered slot pairs
 * `เข้า [n]` / `ออก [n]` (`HH:MM`). Each non-empty slot time becomes one scan row (`in` / `out`), so the
 * existing staging, identity, idempotency and derivation paths are reused unchanged.
 *
 * These rows are REPORT-DERIVED: the vendor software already chose the in/out times, so they are not
 * original device punches. That is recorded twice: the batch (and therefore every staging row and
 * attendance event) carries `source_system = hip_daily_report`, and each row's payload says
 * `origin: report_derived` with its slot.
 *
 * Everything else in the report (name, department, status, work time, late, early-leave, remark) is
 * dropped here — AR-0001 recomputes lateness, and names never leave this module.
 *
 * Fail closed: the whole file is validated first and one bad line refuses the file.
 */

const CODE_HEADER = 'รหัสที่เครื่อง';
const DATE_HEADER = 'วัน/เวลา';
const SLOT_HEADER = /^(เข้า|ออก)\s*\[(\d+)\]$/;
const DATE_ONLY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const TIME_ONLY = /^\d{1,2}:\d{2}$/;

function readHeader(cells) {
  const header = cells.map((cell) => cell.trim());
  const position = (name) => {
    const first = header.indexOf(name);
    if (first === -1) return -1;
    if (header.lastIndexOf(name) !== first) throw new FacescanFileError(`header repeats column: ${name}`);
    return first;
  };
  const code = position(CODE_HEADER);
  const date = position(DATE_HEADER);
  const missing = [[CODE_HEADER, code], [DATE_HEADER, date]].filter(([, at]) => at === -1).map(([name]) => name);
  if (missing.length > 0) {
    throw new FacescanFileError(`not a HIP daily report: header is missing ${missing.join(', ')}`);
  }

  const slots = new Map();
  header.forEach((name, at) => {
    const match = SLOT_HEADER.exec(name);
    if (!match) return;
    const slot = Number(match[2]);
    const kind = match[1] === 'เข้า' ? 'in' : 'out';
    const entry = slots.get(slot) || {};
    if (entry[kind] !== undefined) throw new FacescanFileError(`header repeats column: ${name}`);
    entry[kind] = at;
    slots.set(slot, entry);
  });
  if (slots.size === 0) throw new FacescanFileError('not a HIP daily report: no เข้า [n] / ออก [n] columns');
  for (const [slot, entry] of slots) {
    if (entry.in === undefined || entry.out === undefined) {
      throw new FacescanFileError(`slot [${slot}] needs both เข้า [${slot}] and ออก [${slot}] columns`);
    }
  }
  return { code, date, slots: [...slots.entries()].sort(([a], [b]) => a - b) };
}

/**
 * @param {Buffer|string} input file content
 * @returns {{ rows: Array<{facescanId, scanDatetime, scanType, payload}>, contentSha256: string,
 *             summary: { reportRows: number, daysWithScans: number, daysWithoutScans: number } }}
 * @throws {FacescanFileError} with `issues[]` ({ line, message }) when any line is invalid
 */
function parseHipDailyReport(input) {
  const text = decodeBuffer(input);
  const contentSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const records = parseCsv(text);
  if (records.length === 0) throw new FacescanFileError('file is empty');
  const header = readHeader(records[0].cells);

  const rows = [];
  const issues = [];
  const seenDays = new Map();
  let daysWithScans = 0;
  let daysWithoutScans = 0;

  for (const { line, cells } of records.slice(1)) {
    const cell = (at) => String(cells[at] ?? '').trim();
    const facescanId = cell(header.code);
    const date = cell(header.date);
    const lineIssues = [];

    if (!facescanId) lineIssues.push('รหัสที่เครื่อง is empty');
    else if (facescanId.length > FACESCAN_ID_MAX) lineIssues.push(`รหัสที่เครื่อง exceeds ${FACESCAN_ID_MAX} characters`);
    // A time inside the date cell would be a second, competing source of times; refuse instead of choosing.
    if (!DATE_ONLY.test(date) || !parseScanDatetime(`${date} 00:00`)) {
      lineIssues.push('วัน/เวลา must be a Buddhist-era date DD/MM/BBBB');
    }

    const dayRows = [];
    if (lineIssues.length === 0) {
      const dayKey = `${facescanId}|${date}`;
      if (seenDays.has(dayKey)) lineIssues.push(`same code and date as line ${seenDays.get(dayKey)}`);
      else seenDays.set(dayKey, line);

      for (const [slot, columns] of header.slots) {
        const times = {};
        for (const kind of ['in', 'out']) {
          const value = cell(columns[kind]);
          if (value === '') continue;
          const scanDatetime = TIME_ONLY.test(value) ? parseScanDatetime(`${date} ${value}`) : null;
          if (!scanDatetime) {
            lineIssues.push(`${kind === 'in' ? 'เข้า' : 'ออก'} [${slot}] is not a time HH:MM`);
            continue;
          }
          times[kind] = scanDatetime;
          dayRows.push({
            facescanId,
            scanDatetime,
            scanType: kind,
            payload: { sourceLine: line, origin: 'report_derived', slot, kind },
          });
        }
        // Overnight slots are not modelled downstream (pickTimes keeps one calendar date), so an out
        // before its in is refused rather than silently attributed to the wrong day.
        if (times.in && times.out && times.out < times.in) {
          lineIssues.push(`ออก [${slot}] is earlier than เข้า [${slot}]`);
        }
      }
    }

    if (lineIssues.length > 0) {
      for (const message of lineIssues) issues.push({ line, message });
      continue;
    }
    if (dayRows.length === 0) {
      // A report row with no times is a day without scans. It is not an error and creates nothing:
      // absence is an HR decision, never inferred here.
      daysWithoutScans += 1;
      continue;
    }
    daysWithScans += 1;
    rows.push(...dayRows);
  }

  if (issues.length > 0) {
    throw new FacescanFileError(
      `${issues.length} invalid line(s); the file was not imported`,
      issues.slice(0, MAX_REPORTED_ISSUES),
    );
  }
  const reportRows = daysWithScans + daysWithoutScans;
  if (reportRows === 0) throw new FacescanFileError('file has a header but no report rows');
  if (rows.length === 0) throw new FacescanFileError('report has no scan times at all');
  return { rows, contentSha256, summary: { reportRows, daysWithScans, daysWithoutScans } };
}

module.exports = { parseHipDailyReport };
