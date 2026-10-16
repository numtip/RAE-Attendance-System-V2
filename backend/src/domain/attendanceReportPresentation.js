/**
 * R-03 export presentation layer. PURE: no I/O, no clock, no database.
 *
 * This module is the ONE place where a stored report becomes displayable text, so the PDF and the XLSX can
 * never disagree about a date, a status label or a number. It reads the R-02 payload and never re-derives a
 * figure: `buildExportModel` copies the numbers as they were returned, so an exported total is byte-for-byte
 * the total the JSON endpoint reports.
 *
 * Rules this file enforces:
 *
 *  1. Buddhist Era is DISPLAY ONLY. `toBuddhistYear` is called while formatting a label; the Gregorian
 *     value stays in `period` (and therefore in the filename, the query and any machine-readable field).
 *  2. Bangkok wall time comes from `utils/bangkokTime` (standing rule 1: never `String(x).slice(0, 10)`),
 *     so a UTC instant and a naive DATETIME describe the same calendar day the same way.
 *  3. A number stays a number. Only a figure that genuinely could not be derived (`null`) becomes the Thai
 *     sentence 'ไม่สามารถคำนวณได้' — never a zero, which would read as "nothing happened".
 *  4. An incomplete report always produces a `watermark`, so no renderer has to decide whether to warn.
 */
const { formatBangkokWall, wallDateOnly } = require('../utils/bangkokTime');
const { NOT_DERIVED } = require('./attendanceReport');

/** Full Thai month names, index 1-12 (index 0 is unused so a month number indexes directly). */
const THAI_MONTHS = Object.freeze([
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]);

/** Abbreviated Thai month names, index 1-12. Used in a table cell where the full name would not fit. */
const THAI_MONTHS_SHORT = Object.freeze([
  '', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]);

/** Thai weekday names, index 0 = Monday .. 6 = Sunday (ISO weekday - 1). */
const THAI_DAY_NAMES = Object.freeze([
  'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์',
]);

/** Every `ReportComputationStatus` from `domain/attendanceReport.js`, plus the layer's own `not_derived`. */
const STATUS_LABEL_TH = Object.freeze({
  calculated: 'คำนวณแล้ว',
  no_data: 'ไม่มีข้อมูล',
  insufficient_data: 'ข้อมูลไม่เพียงพอ',
  partial: 'ข้อมูลยังไม่ครบถ้วน',
  pending_policy: 'รอนโยบายที่ยังไม่อนุมัติ',
  failed: 'คำนวณไม่สำเร็จ',
  [NOT_DERIVED]: 'ยังไม่ได้ประมวลผล',
});

/** The `daily_attendance.status` vocabulary. */
const DAY_STATUS_LABEL_TH = Object.freeze({
  present: 'มาทำงาน',
  late: 'มาสาย',
  absent: 'ขาดงาน',
  leave: 'ลา',
  holiday: 'วันหยุด',
  pending: 'รอประมวลผล',
});

const DRAFT_LABEL = 'DRAFT';
const DRAFT_WATERMARK_TEXT = 'ข้อมูลยังไม่สมบูรณ์';
const DRAFT_NOTE_TH = 'เอกสารฉบับร่าง — ข้อมูลยังไม่สมบูรณ์ ห้ามใช้เป็นผลสรุป';

const REPORT_TITLE_BY_KIND = Object.freeze({
  day: 'รายงานการมาทำงานรายวัน',
  month: 'รายงานการมาทำงานรายเดือน',
  academic_year: 'รายงานการมาทำงานรายปีการศึกษา',
});

/** The five month-total fields that are read verbatim from the stored month row. */
const TOTALS_LABELS = Object.freeze([
  ['totalWorkDays', 'วันทำงานทั้งหมด (วัน)'],
  ['totalPresent', 'มาทำงาน (วัน)'],
  ['totalLate', 'มาสาย (วัน)'],
  ['totalAbsent', 'ขาดงาน (วัน)'],
  ['totalLeave', 'ลา (วัน)'],
  ['totalLateMinutes', 'นาทีที่มาสายรวม'],
  ['totalEarlyMinutes', 'นาทีที่ออกก่อนรวม'],
  ['totalWorkHours', 'ชั่วโมงทำงานรวม'],
  ['expectedWorkingDays', 'วันทำงานที่คาดหมาย'],
  ['pendingDays', 'วันที่ยังรอประมวลผล'],
  ['holidayDays', 'วันหยุด'],
]);

/** Gregorian year -> Buddhist Era year. DISPLAY ONLY; never write this back into data or a filename. */
function toBuddhistYear(gregorianYear) {
  if (gregorianYear == null || gregorianYear === '') return null;
  const year = Number(gregorianYear);
  return Number.isFinite(year) ? year + 543 : null;
}

/** 'YYYY-MM-DD' -> '2 มีนาคม 2569' (full) or '02/03/2569' (short). Null in, null out. */
function formatThaiDate(isoDate, { short = false } = {}) {
  if (isoDate == null || isoDate === '') return null;
  const day = wallDateOnly(isoDate);
  if (!day) return String(isoDate);
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date || month < 1 || month > 12) return String(isoDate);
  const be = toBuddhistYear(year);
  if (short) {
    return `${String(date).padStart(2, '0')}/${String(month).padStart(2, '0')}/${be}`;
  }
  return `${date} ${THAI_MONTHS[month]} ${be}`;
}

/** A Bangkok wall timestamp -> '2 มีนาคม 2569 14:05'. Accepts an ISO instant or a naive wall value. */
function formatThaiDateTime(value) {
  if (value == null || value === '') return null;
  const isDate = value instanceof Date;
  const text = isDate ? null : String(value);
  const hasZone = isDate || /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text || '');

  if (hasZone) {
    const parsed = isDate ? value : new Date(text);
    if (Number.isNaN(parsed.getTime())) return formatThaiDate(wallDateOnly(value));
    // BOTH the day and the clock must come from the same +7 shift: taking the UTC day and the Bangkok time
    // would print the wrong date for any instant between 17:00 and 24:00 UTC.
    const [day, time] = formatBangkokWall(parsed).split(' ');
    return `${formatThaiDate(day)} ${time.slice(0, 5)}`;
  }

  // A naive DATETIME is already Bangkok wall time, so it must not be offset a second time.
  const day = wallDateOnly(value);
  if (!day) return String(value);
  const match = /[ T](\d{2}):(\d{2})/.exec(text || '');
  return match ? `${formatThaiDate(day)} ${match[1]}:${match[2]}` : formatThaiDate(day);
}

/** 'HH:MM' of a stored wall timestamp, or '—'. Used for a table cell where the date is a separate column. */
function formatClock(value) {
  if (value == null || value === '') return '—';
  const match = /(\d{2}):(\d{2})/.exec(String(value));
  return match ? `${match[1]}:${match[2]}` : String(value);
}

/** A statically-known Thai label, or the raw code so an unknown status is traceable rather than invented. */
function labelOf(map, code, fallback = '—') {
  if (code == null || code === '') return fallback;
  const key = String(code);
  return map[key] ?? key;
}

/**
 * Turn a machine `statusReasons` code into a sentence a reader can act on.
 *
 * The codes are produced by `attendanceReportService` and are deliberately machine-shaped, so the mapping
 * is exhaustive for the codes that service can emit and falls back to a traceable Thai prefix for anything
 * new. Numeric detail (`unjudged_days:N`) is carried through rather than dropped.
 */
function statusReasonToThai(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return null;

  const withKey = /^month_not_derived:(\d{4}-\d{2})$/.exec(raw);
  if (withKey) return `เดือน ${withKey[1]} ยังไม่ได้รับการประมวลผล (ไม่มีข้อมูลที่จัดเก็บ)`;

  const monthWithStatus = /^month_([a-z_]+):(\d{4}-\d{2})$/.exec(raw);
  if (monthWithStatus) {
    const [, status, key] = monthWithStatus;
    return `เดือน ${key}: ${labelOf(STATUS_LABEL_TH, status, status)}`;
  }

  const unjudged = /^unjudged_days:(\d+)$/.exec(raw);
  if (unjudged) return `ยังมีอีก ${unjudged[1]} วันที่ตัดสินไม่ได้ จึงสรุปเป็นยอดรวมไม่ได้`;

  const dayReason = /^day_reason:(.+)$/.exec(raw);
  if (dayReason) return `เหตุผลประกอบจากระบบตัดสิน: ${dayReason[1]}`;

  if (raw === 'day_never_calculated') return 'วันนี้ยังไม่ถูกประมวลผล (ไม่มีข้อมูลที่จัดเก็บ)';
  if (raw === 'month_never_derived') return 'เดือนนี้ยังไม่ถูกประมวลผล (ไม่มีข้อมูลที่จัดเก็บ)';
  if (raw === 'month_no_daily_rows') return 'ไม่มีข้อมูลรายวันสำหรับเดือนนี้';
  if (raw === 'month_partial') return 'เดือนนี้ยังตัดสินไม่ครบทุกวัน จึงยังไม่ใช่ผลสรุป';
  if (raw === 'month_pending_policy') return 'เดือนนี้รอนโยบายที่ยังไม่ได้รับอนุมัติ จึงยังไม่ใช่ผลสรุป';
  if (raw === 'month_not_yet_started') return 'เดือนนี้ยังไม่เริ่มต้น จึงยังไม่มีข้อมูล';
  if (raw === 'academic_year_not_closed') return 'ปีการศึกษานี้ยังไม่สิ้นสุด ช่วงเวลาจึงยังไม่ปิด';

  const dayStatus = /^day_([a-z_]+)$/.exec(raw);
  if (dayStatus) return `สถานะรายวัน: ${labelOf(STATUS_LABEL_TH, dayStatus[1], dayStatus[1])}`;

  const monthStatus = /^month_([a-z_]+)$/.exec(raw);
  if (monthStatus) return `สถานะเดือน: ${labelOf(STATUS_LABEL_TH, monthStatus[1], monthStatus[1])}`;

  return `สถานะที่ต้องตรวจสอบ: ${raw}`;
}

/** Keep only the characters that are safe in an ASCII filename segment. */
function asciiSlug(value, { keepDash = false, maxLength = 32 } = {}) {
  const pattern = keepDash ? /[^A-Za-z0-9-]/g : /[^A-Za-z0-9]/g;
  return String(value ?? '').replace(pattern, '').slice(0, maxLength);
}

/**
 * `attendance-report-<kind>-<period>-<uid8>.<ext>` — ASCII only.
 *
 * The uid arrives from a URL path segment, so it is treated as hostile: every character that is not
 * `[A-Za-z0-9]` is dropped, which removes path separators, dots, quotes, spaces and control characters by
 * construction. Thai belongs in the file BODY, never in a `Content-Disposition` filename, where the encoding
 * is not guaranteed.
 */
function safeExportFileName({ kind, period, employeeUid, format } = {}) {
  const kindSlug = asciiSlug(kind, { maxLength: 20 }) || 'report';
  const periodSlug = asciiSlug(period, { keepDash: true, maxLength: 24 }) || 'period';
  const uidSlug = asciiSlug(employeeUid, { maxLength: 8 }) || 'unknown';
  const extension = asciiSlug(format, { maxLength: 8 }) || 'bin';
  const name = `attendance-report-${kindSlug}-${periodSlug}-${uidSlug}.${extension}`;
  return name.slice(0, 120);
}

/** A number stays a number; only a genuinely underivable figure becomes a sentence. */
function numberOrUnavailable(value) {
  if (value == null) return 'ไม่สามารถคำนวณได้';
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value);
}

function countOrDash(value) {
  if (value == null) return '—';
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value);
}

/** The `meta` block every artifact carries: provenance and the honesty verdict, in that order. */
function buildMetaRows(report, { generatedAt }) {
  const statusLabel = labelOf(STATUS_LABEL_TH, report.computationStatus, '—');
  const population = report.population ?? {};
  const ruleVersions = Array.isArray(report.ruleVersions) ? report.ruleVersions : [];
  const rows = [
    { label: 'สถานะการคำนวณ (computationStatus)', value: `${statusLabel} (${report.computationStatus ?? '—'})` },
    { label: 'สรุปเป็นผลสรุปได้ (isFinal)', value: report.isFinal === true ? 'ใช่ (true)' : 'ไม่ใช่ (false)' },
    {
      label: 'ประชากรของรายงาน (population)',
      value: `${countOrDash(population.employees)} คน · uid ${population.employeeUid ?? '—'} · `
        + `${countOrDash(population.dayRows)} แถวรายวัน`,
    },
    { label: 'วันที่ตัดข้อมูล (dateCutoff)', value: formatThaiDate(report.dateCutoff) ?? '—' },
    { label: 'เวอร์ชันกฎที่ใช้ (ruleVersions)', value: ruleVersions.length > 0 ? ruleVersions.join(', ') : '—' },
    { label: 'แหล่งข้อมูล (generatedFrom)', value: report.generatedFrom ?? '—' },
  ];
  const generated = formatThaiDateTime(generatedAt);
  if (generated) rows.push({ label: 'สร้างเอกสารเมื่อ', value: generated });
  return rows;
}

function buildPeriod(report, kind) {
  const period = report.period ?? {};
  if (kind === 'month') {
    const year = Number(period.year);
    const month = Number(period.month);
    const label = THAI_MONTHS[month]
      ? `${THAI_MONTHS[month]} ${toBuddhistYear(year)}`
      : String(period.key ?? '—');
    return {
      label,
      fromTh: formatThaiDate(period.from) ?? '—',
      toTh: formatThaiDate(period.to) ?? '—',
    };
  }
  if (kind === 'academic_year') {
    const start = Number(period.academicYear);
    return {
      label: Number.isFinite(start) ? `ปีการศึกษา ${toBuddhistYear(start)}` : '—',
      fromTh: formatThaiDate(period.from) ?? '—',
      toTh: formatThaiDate(period.to) ?? '—',
    };
  }
  return {
    label: formatThaiDate(period.date) ?? '—',
    fromTh: formatThaiDate(period.from) ?? '—',
    toTh: formatThaiDate(period.to) ?? '—',
  };
}

function totalsRows(source) {
  if (!source) return null;
  return TOTALS_LABELS.map(([field, label]) => ({ label, value: numberOrUnavailable(source[field]) }));
}

function caveatRows(caveats) {
  if (!Array.isArray(caveats) || caveats.length === 0) {
    return [{ label: 'caveats', value: 'ไม่มีข้อจำกัดที่บันทึกไว้' }];
  }
  // The detail is English prose authored by R-02 — rendered as-is, never translated (that would be inventing
  // text). The code stays visible so a reader can trace it back to the service.
  return caveats.map((caveat) => ({ label: String(caveat?.code ?? '—'), value: caveat?.detail ?? '—' }));
}

function statusReasonRows(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const translated = list.map(statusReasonToThai).filter(Boolean);
  if (translated.length === 0) {
    return [{ label: 'statusReasons', value: 'ไม่มี — รายงานนี้เป็นผลสรุปที่สมบูรณ์' }];
  }
  return translated.map((text, index) => ({ label: `เหตุผล ${index + 1}`, value: text }));
}

function daySections(kind, payload) {
  const { day, rule } = payload;
  const dayRows = [];
  if (day) {
    dayRows.push(
      { label: 'สถานะวัน', value: labelOf(DAY_STATUS_LABEL_TH, day.status) },
      { label: 'สถานะการคำนวณของวัน', value: labelOf(STATUS_LABEL_TH, day.computationStatus) },
      { label: 'เวลาเข้า', value: formatClock(day.checkIn) },
      { label: 'เวลาออก', value: formatClock(day.checkOut) },
      { label: 'มาสาย (นาที)', value: numberOrUnavailable(day.lateMinutes) },
      { label: 'ออกก่อน (นาที)', value: numberOrUnavailable(day.earlyMinutes) },
      { label: 'เวลาทำงาน (นาที)', value: numberOrUnavailable(day.workDuration) },
      { label: 'ลา', value: day.isLeave === true ? (day.leaveType ?? 'ใช่') : 'ไม่' },
      { label: 'กะข้ามคืน', value: day.isOvernight === true ? 'ใช่' : 'ไม่' },
      { label: 'เวอร์ชันกฎ', value: day.ruleVersionCode ?? '—' },
      { label: 'จำนวนเหตุการณ์ต้นทาง', value: numberOrUnavailable(day.sourceEventCount) },
      { label: 'คำนวณเมื่อ', value: formatThaiDateTime(day.calculatedAt) ?? '—' },
      { label: 'หมายเหตุ', value: day.notes ?? '—' },
    );
  } else {
    dayRows.push({ label: 'ข้อมูลรายวัน', value: 'ไม่พบข้อมูลที่จัดเก็บสำหรับวันนี้ (ไม่ใช่ตัวเลขศูนย์)' });
  }

  const ruleRows = [];
  if (rule) {
    const workDays = Array.isArray(rule.workDays)
      ? rule.workDays.map((entry) => THAI_DAY_NAMES[Number(entry) - 1] ?? String(entry)).join(', ')
      : '—';
    ruleRows.push(
      { label: 'รหัสกฎ', value: rule.ruleVersionCode ?? '—' },
      { label: 'สถานะกฎ', value: rule.status ?? '—' },
      { label: 'มีผลตั้งแต่', value: formatThaiDate(rule.effectiveFrom) ?? '—' },
      { label: 'มีผลถึง', value: formatThaiDate(rule.effectiveTo) ?? '—' },
      { label: 'เวลาทำงาน', value: `${rule.workStart ?? '—'} - ${rule.workEnd ?? '—'}` },
      { label: 'สายหลัง', value: rule.lateAfter ?? '—' },
      { label: 'ออกก่อน', value: rule.earlyBefore ?? '—' },
      { label: 'วันทำงาน', value: workDays },
      { label: 'อนุมัติโดย', value: rule.approvedBy ?? '—' },
    );
  } else {
    ruleRows.push({ label: 'กฎที่ใช้คำนวณ', value: 'ไม่พบเวอร์ชันกฎที่อ้างอิงสำหรับวันนี้' });
  }

  const sections = [
    { type: 'facts', title: 'สรุปของวัน', rows: dayRows },
    { type: 'facts', title: 'กฎที่ใช้คำนวณ', rows: ruleRows },
  ];
  void kind;
  return sections;
}

function monthSections(payload) {
  const { month, days, dayCounts } = payload;
  const sections = [];

  if (month) {
    sections.push({ type: 'totals', title: 'ยอดรวมของเดือน', rows: totalsRows(month) });
  } else {
    sections.push({
      type: 'facts',
      title: 'ยอดรวมของเดือน',
      rows: [{ label: 'ข้อมูลเดือน', value: 'ยังไม่ถูกประมวลผล — ไม่มีข้อมูลที่จัดเก็บ (ไม่ใช่ยอดรวมศูนย์)' }],
    });
  }

  const dayList = Array.isArray(days) ? days : [];
  if (dayList.length > 0) {
    sections.push({
      type: 'days',
      title: 'รายละเอียดรายวัน',
      columns: [
        { key: 'date', header: 'วันที่', width: 13, type: 'text', align: 'left' },
        { key: 'status', header: 'สถานะ', width: 13, type: 'text', align: 'left' },
        { key: 'checkIn', header: 'เวลาเข้า', width: 10, type: 'text', align: 'center' },
        { key: 'checkOut', header: 'เวลาออก', width: 10, type: 'text', align: 'center' },
        { key: 'lateMinutes', header: 'สาย (นาที)', width: 10, type: 'number', align: 'right' },
        { key: 'workDuration', header: 'ทำงาน (นาที)', width: 12, type: 'number', align: 'right' },
        { key: 'computationStatus', header: 'การคำนวณ', width: 20, type: 'text', align: 'left' },
      ],
      rows: dayList.map((entry) => [
        formatThaiDate(entry.date, { short: true }) ?? '—',
        labelOf(DAY_STATUS_LABEL_TH, entry.status),
        formatClock(entry.checkIn),
        formatClock(entry.checkOut),
        numberOrUnavailable(entry.lateMinutes),
        numberOrUnavailable(entry.workDuration),
        labelOf(STATUS_LABEL_TH, entry.computationStatus),
      ]),
    });
  }

  const facts = [];
  if (month) {
    facts.push(
      { label: 'เวอร์ชันกฎของเดือน', value: (month.ruleVersions ?? []).join(', ') || '—' },
      { label: 'คำนวณเมื่อ', value: formatThaiDateTime(month.calculatedAt) ?? '—' },
      { label: 'แหล่งที่มา', value: month.sourceKind ?? '—' },
    );
  }
  facts.push(
    { label: 'จำนวนวันที่มีข้อมูล', value: countOrDash(dayCounts?.rows) },
    { label: 'ยอดรวมวันที่คาดหมาย', value: numberOrUnavailable(month?.expectedWorkingDays ?? null) },
  );
  sections.push({ type: 'facts', title: 'ข้อมูลประกอบของเดือน', rows: facts });
  return sections;
}

function academicYearSections(payload) {
  const { months, yearSummary } = payload;
  const list = Array.isArray(months) ? months : [];
  const summary = yearSummary ?? {};
  const sections = [];

  sections.push({ type: 'totals', title: 'ยอดรวมของปีการศึกษา', rows: totalsRows(summary.totals) ?? [{ label: 'ยอดรวม', value: 'ไม่สามารถคำนวณได้' }] });

  if (list.length > 0) {
    sections.push({
      type: 'months',
      title: 'รายเดือนของปีการศึกษา',
      columns: [
        { key: 'key', header: 'เดือน', width: 12, type: 'text', align: 'left' },
        { key: 'status', header: 'สถานะการคำนวณ', width: 20, type: 'text', align: 'left' },
        { key: 'final', header: 'สรุปได้', width: 10, type: 'text', align: 'center' },
        { key: 'available', header: 'มีข้อมูล', width: 10, type: 'text', align: 'center' },
        { key: 'cutoff', header: 'ตัดข้อมูล', width: 13, type: 'text', align: 'center' },
        { key: 'present', header: 'มา (วัน)', width: 9, type: 'number', align: 'right' },
        { key: 'absent', header: 'ขาด (วัน)', width: 9, type: 'number', align: 'right' },
        { key: 'hours', header: 'ชั่วโมงรวม', width: 11, type: 'number', align: 'right' },
      ],
      rows: list.map((entry) => [
        THAI_MONTHS_SHORT[Number(entry.month)]
          ? `${THAI_MONTHS_SHORT[Number(entry.month)]} ${toBuddhistYear(entry.year)}`
          : String(entry.key ?? '—'),
        labelOf(STATUS_LABEL_TH, entry.computationStatus),
        entry.isFinal === true ? 'สรุปได้' : 'ยังไม่สรุป',
        entry.reportAvailable === true ? 'มี' : 'ไม่มี',
        formatThaiDate(entry.dateCutoff, { short: true }) ?? '—',
        countOrDash(entry.totals?.totalPresent),
        countOrDash(entry.totals?.totalAbsent),
        countOrDash(entry.totals?.totalWorkHours),
      ]),
    });
  }

  const notStarted = Array.isArray(summary.monthsNotYetStarted) ? summary.monthsNotYetStarted : [];
  const missing = Array.isArray(summary.monthsMissing) ? summary.monthsMissing : [];
  sections.push({
    type: 'facts',
    title: 'ข้อมูลประกอบของปีการศึกษา',
    rows: [
      { label: 'ช่วงเวลาของปีการศึกษา', value: `${formatThaiDate(summary.from) ?? '—'} - ${formatThaiDate(summary.to) ?? '—'}` },
      { label: 'ช่วงเวลาปิดแล้ว', value: summary.periodClosed === true ? 'ใช่' : 'ไม่ใช่' },
      { label: 'ข้อมูล ณ วันที่', value: formatThaiDate(summary.asOf) ?? '—' },
      { label: 'เดือนในรอบปีการศึกษา', value: countOrDash(summary.monthsInPeriod) },
      { label: 'เดือนที่เริ่มแล้ว', value: countOrDash(summary.monthsStarted) },
      { label: 'เดือนที่ยังไม่เริ่ม', value: notStarted.join(', ') || '—' },
      { label: 'เดือนที่ยังไม่มีข้อมูล', value: missing.join(', ') || '—' },
      { label: 'วันทำงานที่คาดหมายรวม', value: numberOrUnavailable(summary.totals?.expectedWorkingDays ?? null) },
    ],
  });
  return sections;
}

/**
 * The single canonical export model, consumed by BOTH the PDF and the XLSX renderer.
 *
 * `payload` is the R-02 response body (`{ report, day, rule }` / `{ report, month, days, dayCounts }` /
 * `{ report, months, yearSummary }`) with an optional `employee` display record attached by the export
 * service. The payload supplies every number; this function only formats labels.
 */
function buildExportModel(payload = {}, { kind, generatedAt = null } = {}) {
  const report = payload.report ?? {};
  const resolvedKind = kind ?? report.kind;
  const isFinal = report.isFinal === true;
  const employee = payload.employee ?? {};

  let sections;
  if (resolvedKind === 'month') sections = monthSections(payload);
  else if (resolvedKind === 'academic_year') sections = academicYearSections(payload);
  else sections = daySections(resolvedKind, payload);

  const caveats = Array.isArray(report.caveats) ? report.caveats : [];
  sections.push({ type: 'facts', title: 'ข้อจำกัดของข้อมูล (caveats)', rows: caveatRows(caveats) });
  sections.push({
    type: 'facts',
    title: 'เหตุผลที่รายงานนี้ยังไม่สมบูรณ์ (statusReasons)',
    rows: statusReasonRows(report.statusReasons),
  });

  return {
    kind: resolvedKind,
    title: REPORT_TITLE_BY_KIND[resolvedKind] ?? 'รายงานการมาทำงาน',
    isFinal,
    computationStatus: report.computationStatus ?? null,
    statusLabelTh: labelOf(STATUS_LABEL_TH, report.computationStatus, '—'),
    watermark: isFinal ? null : { label: DRAFT_LABEL, text: DRAFT_WATERMARK_TEXT, noteTh: DRAFT_NOTE_TH },
    meta: buildMetaRows(report, { generatedAt }),
    employee: {
      employeeId: employee.employeeId ?? '—',
      nameTh: employee.nameTh ?? '—',
      department: employee.department ?? '—',
      position: employee.position ?? '—',
    },
    period: buildPeriod(report, resolvedKind),
    sections,
    caveats,
    statusReasons: statusReasonRows(report.statusReasons).map((row) => row.value),
  };
}

module.exports = {
  THAI_MONTHS,
  THAI_MONTHS_SHORT,
  THAI_DAY_NAMES,
  STATUS_LABEL_TH,
  DAY_STATUS_LABEL_TH,
  DRAFT_LABEL,
  DRAFT_WATERMARK_TEXT,
  DRAFT_NOTE_TH,
  REPORT_TITLE_BY_KIND,
  TOTALS_LABELS,
  toBuddhistYear,
  formatThaiDate,
  formatThaiDateTime,
  formatClock,
  labelOf,
  statusReasonToThai,
  safeExportFileName,
  buildExportModel,
};
