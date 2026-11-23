/**
 * HR leave-data CSV: parsing and row validation. PURE — no database, no filesystem, no clock (the caller passes
 * `today`). The rules are the ones in docs/policies/HR_LEAVE_DATA_ONBOARDING.md §4.
 *
 * A row is judged on what the file itself says. Whatever needs the database (does the employee exist, is the type
 * the registered one, what is stored today) is the import tool's job, so this module can be tested without one.
 *
 * Output never carries the personal values of a row — only line numbers and rule codes — so a report can be shared.
 */

const EMPLOYEE_ID_PATTERN = /^\d{4}$/;
const MAX_ROWS = 1000;
const NOTE_MAX = 200;
const CLEAR = '-'; // an explicit "clear this value"; a blank cell leaves the stored value alone

const PROFILE_COLUMNS = Object.freeze({
  employeeId: 'รหัส',
  name: 'ชื่อ-นามสกุล',
  type: 'ประเภทบุคลากร',
  hireDate: 'วันที่เริ่มงาน',
  continuousServiceStart: 'วันที่เริ่มปฏิบัติงานต่อเนื่อง',
  appointmentKind: 'ประเภทการบรรจุ',
  eligibilityConfirmed: 'การยืนยันสิทธิ์ตามประกาศ',
  eligibilityReference: 'เลขที่หนังสือยืนยัน',
  sourceReference: 'แหล่งข้อมูล/เอกสารอ้างอิง',
  note: 'หมายเหตุ',
});

const ENTITLEMENT_COLUMNS = Object.freeze({
  employeeId: 'รหัส',
  fiscalYearBe: 'ปีงบประมาณ (พ.ศ.)',
  leaveType: 'ประเภทการลา',
  entitlementDays: 'สิทธิ์ที่ได้รับในปีนี้ (วันทำการ)',
  carryoverDays: 'ยอดสะสมยกมา (วันทำการ)',
  usageBaselineDays: 'ใช้ไปแล้วก่อนเริ่มนับในระบบ (วันทำการ)',
  usageBaselineThrough: 'นับถึงวันที่',
  sourceReference: 'แหล่งข้อมูล/เอกสารอ้างอิง',
  note: 'หมายเหตุ',
});

const APPOINTMENT_KINDS = Object.freeze({
  'บรรจุครั้งแรก': 'first',
  'กลับมาบรรจุใหม่หลังลาออกเพราะเหตุส่วนตัว': 'rehire_after_resignation',
  'กลับมาบรรจุใหม่หลังถูกสั่งให้ออก': 'rehire_after_dismissal',
  'อื่น ๆ (เปลี่ยนสถานภาพ/จ้างต่อเนื่อง)': 'other',
});
const LEAVE_TYPES = Object.freeze({ 'ลาป่วย': 'sick', 'ลากิจส่วนตัว': 'personal', 'ลาพักผ่อน': 'vacation' });
const CONFIRMATION = Object.freeze({ 'ใช่': true, 'ไม่ใช่': false });

/** First fiscal year the entitlement table accepts, and the first date for which an appointment kind is needed. */
const FIRST_FISCAL_YEAR_BE = 2569;
const APPOINTMENT_KIND_REQUIRED_FROM = '2025-10-01';

// ---------------------------------------------------------------- CSV text

/**
 * RFC-4180-style parser: quotes, escaped quotes, commas and line breaks inside quotes, CRLF/LF, UTF-8 BOM.
 * Returns `{ header, rows: [{ line, cells }] }` where `line` is the 1-based line of the row's first character,
 * or `{ fileError }` when the text cannot be a table at all.
 */
function parseCsv(text) {
  const source = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
  const records = [];
  let cell = '';
  let record = [];
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else { cell += ch; if (ch === '\n') line += 1; }
      continue;
    }
    if (ch === '"') { quoted = true; touched = true; } else if (ch === ',') { record.push(cell); cell = ''; touched = true; } else if (ch === '\r') { /* handled with \n */ } else if (ch === '\n') {
      if (touched || cell !== '' || record.length) { record.push(cell); records.push({ line: recordLine, cells: record }); }
      cell = ''; record = []; touched = false; line += 1; recordLine = line;
    } else { cell += ch; touched = true; }
  }
  if (quoted) return { fileError: 'unterminated_quote' };
  if (touched || cell !== '' || record.length) { record.push(cell); records.push({ line: recordLine, cells: record }); }
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { fileError: 'empty_file' };
  const [head, ...rest] = nonEmpty;
  return { header: head.cells.map((c) => c.trim()), rows: rest };
}

/** Exact header contract: every template column present once, no extra columns; order is free. */
function checkHeader(header, columns) {
  const expected = Object.values(columns);
  const errors = [];
  const seen = new Set();
  for (const name of header) {
    if (seen.has(name)) errors.push('duplicate_column');
    seen.add(name);
    if (!expected.includes(name)) errors.push('unknown_column');
  }
  for (const name of expected) if (!seen.has(name)) errors.push('missing_column');
  return [...new Set(errors)];
}

// ---------------------------------------------------------------- field parsers

const pad = (n) => String(n).padStart(2, '0');

function realDate(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** `YYYY-MM-DD` (Gregorian) or `DD/MM/YYYY` with a Buddhist-era year (>= 2400); anything else is null. */
function parseHrDate(value) {
  const text = String(value).trim();
  let y; let m; let d;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) { [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]; } else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 2400) return null; // a two-digit-ambiguous or Gregorian slash date is refused, not guessed
    y -= 543;
  }
  if (y < 1950 || y > 2100 || !realDate(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Working days: a plain number in steps of 0.5 within [0, max]; null when it is anything else. */
function parseDays(value, max) {
  const text = String(value).trim();
  if (!/^\d+(\.\d)?$/.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= max && Number.isInteger(n * 2) ? n : null;
}

const addDaysIso = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** Fiscal year (BE) of a Gregorian date, 1 Oct - 30 Sep. */
function fiscalYearBeOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return (m >= 10 ? y + 1 : y) + 543;
}

// ---------------------------------------------------------------- row validation

function cellOf(row, header, name) {
  const index = header.indexOf(name);
  return index === -1 ? '' : String(row.cells[index] ?? '').trim();
}

function newRow(row) { return { line: row.line, errors: [], warnings: [], data: {} }; }

function checkId(out, value) {
  if (!EMPLOYEE_ID_PATTERN.test(value)) out.errors.push('id_format');
  else out.data.employeeId = value;
}

/** An optional date: '' = leave as stored, '-' = clear, otherwise a real date. */
function optionalDate(out, value, field) {
  if (value === '') return undefined;
  if (value === CLEAR) { out.data[field] = null; return null; }
  const iso = parseHrDate(value);
  if (!iso) { out.errors.push('date_format'); return undefined; }
  out.data[field] = iso;
  return iso;
}

/**
 * Profile file. `today` (YYYY-MM-DD) bounds a hire date that lies in the future. Returns
 * `{ fileErrors, rows }`; each row `{ line, errors, warnings, data }` where `data` holds only the cells that
 * carry a value (`null` = clear, absent = leave alone).
 */
function validateProfile(parsed, { today }) {
  if (parsed.fileError) return { fileErrors: [parsed.fileError], rows: [] };
  const fileErrors = checkHeader(parsed.header, PROFILE_COLUMNS);
  if (parsed.rows.length > MAX_ROWS) fileErrors.push('too_many_rows');
  if (fileErrors.length) return { fileErrors, rows: [] };

  const seen = new Set();
  const rows = parsed.rows.map((raw) => {
    const out = newRow(raw);
    if (raw.cells.length !== parsed.header.length) { out.errors.push('row_columns'); return out; }
    const get = (key) => cellOf(raw, parsed.header, PROFILE_COLUMNS[key]);
    checkId(out, get('employeeId'));
    if (out.data.employeeId) {
      if (seen.has(out.data.employeeId)) out.errors.push('id_duplicate');
      seen.add(out.data.employeeId);
    }
    out.type = get('type') || null; // matched against the registry by the caller
    out.name = get('name') || null; // compared by the caller; never echoed

    const hire = optionalDate(out, get('hireDate'), 'hireDate');
    if (typeof hire === 'string' && hire > addDaysIso(today, 366)) out.errors.push('hire_in_future');
    if (get('hireDate') === '') out.warnings.push('hire_missing');
    const continuity = optionalDate(out, get('continuousServiceStart'), 'continuousServiceStart');
    if (typeof hire === 'string' && typeof continuity === 'string' && continuity > hire) out.errors.push('continuity_after_hire');

    const kind = get('appointmentKind');
    if (kind === CLEAR) out.data.appointmentKind = null;
    else if (kind !== '') {
      if (APPOINTMENT_KINDS[kind]) out.data.appointmentKind = APPOINTMENT_KINDS[kind];
      else out.errors.push('appointment_kind_unknown');
    }
    // Only the university policy (clause 23) needs the appointment kind. The file cannot know the person's policy, so the
    // importer, which does, turns this marker into an error for university staff only.
    if (kind === '' && typeof hire === 'string' && hire >= APPOINTMENT_KIND_REQUIRED_FROM) out.appointmentKindRequiredForUniversity = true;

    const confirmation = get('eligibilityConfirmed');
    const reference = get('eligibilityReference');
    if (confirmation === CLEAR) { out.data.eligibilityConfirmed = null; out.data.eligibilityReference = null; } else if (confirmation !== '') {
      if (confirmation in CONFIRMATION) out.data.eligibilityConfirmed = CONFIRMATION[confirmation];
      else out.errors.push('confirmation_value');
      if (reference === '' || reference === CLEAR) out.errors.push('confirmation_needs_reference');
      else out.data.eligibilityReference = reference.slice(0, 120);
    } else if (reference !== '') {
      out.errors.push('confirmation_needs_reference'); // a reference with nothing to confirm
    }

    const source = get('sourceReference');
    const carriesData = Object.keys(out.data).some((k) => k !== 'employeeId');
    if (carriesData && (source === '' || source === CLEAR)) out.errors.push('source_missing');
    else if (source !== '') out.data.sourceReference = source.slice(0, 255);
    if (!carriesData && !out.errors.length) out.warnings.push('no_data');
    if (get('note').length > NOTE_MAX) out.errors.push('note_too_long');
    return out;
  });
  return { fileErrors: [], rows };
}

/**
 * Entitlement file. `currentFiscalYearBe` bounds the years accepted (2569 .. current + 1).
 * `data` holds the cells that carry a value; `null` = clear (carry-over and baseline only).
 */
function validateEntitlement(parsed, { currentFiscalYearBe }) {
  if (parsed.fileError) return { fileErrors: [parsed.fileError], rows: [] };
  const fileErrors = checkHeader(parsed.header, ENTITLEMENT_COLUMNS);
  if (parsed.rows.length > MAX_ROWS) fileErrors.push('too_many_rows');
  if (fileErrors.length) return { fileErrors, rows: [] };

  const seen = new Set();
  const rows = parsed.rows.map((raw) => {
    const out = newRow(raw);
    if (raw.cells.length !== parsed.header.length) { out.errors.push('row_columns'); return out; }
    const get = (key) => cellOf(raw, parsed.header, ENTITLEMENT_COLUMNS[key]);
    checkId(out, get('employeeId'));

    const fy = get('fiscalYearBe');
    if (/^\d{4}$/.test(fy) && Number(fy) >= FIRST_FISCAL_YEAR_BE && Number(fy) <= currentFiscalYearBe + 1) out.data.fiscalYearBe = Number(fy);
    else out.errors.push('fiscal_year_range');

    const type = LEAVE_TYPES[get('leaveType')];
    if (type) out.data.leaveType = type; else out.errors.push('leave_type_unknown');

    if (out.data.employeeId && out.data.fiscalYearBe && out.data.leaveType) {
      const key = `${out.data.employeeId}|${out.data.fiscalYearBe}|${out.data.leaveType}`;
      if (seen.has(key)) out.errors.push('id_duplicate');
      seen.add(key);
    }

    // A template row nobody has filled in carries no data: it is skipped with a warning, it is not an error.
    const cells = ['entitlementDays', 'carryoverDays', 'usageBaselineDays', 'usageBaselineThrough'].map((k) => get(k));
    if (cells.every((c) => c === '')) {
      out.skip = true;
      out.warnings.push('no_data');
      if (get('note').length > NOTE_MAX) out.errors.push('note_too_long');
      return out;
    }

    const entitlement = parseDays(get('entitlementDays'), 120);
    if (entitlement === null) out.errors.push('days_format'); else out.data.entitlementDays = entitlement;

    const carry = get('carryoverDays');
    if (carry === CLEAR) out.data.carryoverDays = null;
    else if (carry !== '') {
      if (type && type !== 'vacation') out.errors.push('carryover_not_vacation');
      else {
        const n = parseDays(carry, 30);
        if (n === null) out.errors.push('days_format'); else out.data.carryoverDays = n;
      }
    }

    const baseDays = get('usageBaselineDays');
    const baseThrough = get('usageBaselineThrough');
    if (baseDays === CLEAR || baseThrough === CLEAR) {
      if ((baseDays === CLEAR) !== (baseThrough === CLEAR)) out.errors.push('baseline_pair');
      else { out.data.usageBaselineDays = null; out.data.usageBaselineThrough = null; }
    } else if (baseDays !== '' || baseThrough !== '') {
      if (baseDays === '' || baseThrough === '') out.errors.push('baseline_pair');
      else {
        const n = parseDays(baseDays, 120);
        const iso = parseHrDate(baseThrough);
        if (n === null) out.errors.push('days_format');
        if (!iso) out.errors.push('date_format');
        if (n !== null && iso) {
          if (out.data.fiscalYearBe && fiscalYearBeOf(iso) !== out.data.fiscalYearBe) out.errors.push('baseline_pair');
          else { out.data.usageBaselineDays = n; out.data.usageBaselineThrough = iso; }
        }
      }
    }

    const source = get('sourceReference');
    if (source === '' || source === CLEAR) out.errors.push('source_missing'); else out.data.sourceReference = source.slice(0, 255);
    if (get('note').length > NOTE_MAX) out.errors.push('note_too_long');
    return out;
  });
  return { fileErrors: [], rows };
}

module.exports = {
  EMPLOYEE_ID_PATTERN, MAX_ROWS, CLEAR, PROFILE_COLUMNS, ENTITLEMENT_COLUMNS, APPOINTMENT_KINDS, LEAVE_TYPES, CONFIRMATION,
  parseCsv, checkHeader, parseHrDate, parseDays, fiscalYearBeOf, validateProfile, validateEntitlement,
};
