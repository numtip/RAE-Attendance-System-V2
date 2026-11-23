import type { EntitlementCell, EntitlementRow, EntitlementScope, LeaveBalanceRow, LeaveKind } from '../api/types';

/** The fields the progress bar depends on (a balance row and an overview cell both have them). */
type MeterInput = Pick<LeaveBalanceRow, 'available' | 'status' | 'usageComplete' | 'totalDays' | 'usedDays' | 'remainingDays'>;

/** Fiscal year (พ.ศ.) the entitlement screen opens on: FY2570 = 2026-10-01 .. 2027-09-30. */
export const DEFAULT_FISCAL_YEAR_BE = 2570;
/** The engine's own bounds (migration 035 / leaveService): earlier or later years are refused by the API. */
export const MIN_FISCAL_YEAR_BE = 2569;
export const MAX_FISCAL_YEAR_BE = 2700;

export type BalanceBasis = 'calendar' | 'fiscal';

const STATUS_LABEL_TH: Record<string, string> = {
  ok: 'คำนวณสิทธิ์แล้ว',
  needs_hr: 'รอยืนยันข้อมูลบุคลากร',
  pending_hr_decision: 'รอ Owner พิจารณา',
  pending_policy: 'รอการตีความนโยบาย',
  unknown: 'ข้อมูลไม่เพียงพอ',
  out_of_scope: 'อยู่นอกขอบเขตประกาศ',
  not_started: 'ยังไม่เริ่มมีสิทธิ์',
};

export function statusLabelTh(status: string | null | undefined): string {
  if (!status) return 'ไม่มีข้อมูล';
  return STATUS_LABEL_TH[status] ?? 'ไม่มีข้อมูล';
}

/** Selectable fiscal years: FY2570 plus the neighbours the API accepts, newest first. Never below the engine minimum. */
export function fiscalYearOptions(): number[] {
  const list: number[] = [];
  for (let y = DEFAULT_FISCAL_YEAR_BE + 1; y >= MIN_FISCAL_YEAR_BE; y -= 1) list.push(y);
  return list;
}

export function fiscalRangeTh(row: Pick<LeaveBalanceRow, 'fiscalYear'>): string | null {
  const fy = row.fiscalYear;
  if (!fy) return null;
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d}/${m}/${y + 543}`;
  };
  return `${fmt(fy.start)} – ${fmt(fy.end)}`;
}

/**
 * Progress bar only when every number behind it is determined: status ok, an entitlement, a used figure and
 * complete usage coverage. Anything else renders no bar — never a 0% bar that would read as "nothing used".
 */
export function isMeterValid(row: MeterInput): boolean {
  if (!row.available) return false;
  if (row.status !== undefined && row.status !== 'ok') return false;
  if (row.usageComplete === false) return false;
  return row.totalDays !== null && row.totalDays > 0 && row.usedDays !== null && row.remainingDays !== null;
}

export function usedPercent(row: MeterInput): number | null {
  if (!isMeterValid(row)) return null;
  const used = row.usedDays as number;
  const total = row.totalDays as number;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** A day count for display; null/undefined is "—" (unknown), never "0". */
export function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const REASON_TH: Record<string, string> = {
  usage_coverage_incomplete: 'ข้อมูลการลาบางเดือนยังไม่ครบ จึงยังไม่คำนวณวันคงเหลือ',
  service_under_3_months: 'ทำงานยังไม่ครบ 3 เดือนตลอดปีงบประมาณนี้ จึงยังไม่มีสิทธิ์ลากิจ',
  service_under_6_months: 'ทำงานยังไม่ครบ 6 เดือนตลอดปีงบประมาณนี้ จึงยังไม่มีสิทธิ์ลาพักผ่อน',
  qualification_mid_year_pending_owner_decision: 'ครบเกณฑ์อายุงานกลางปีงบประมาณ — รอ Owner พิจารณาวิธีจัดสรรสิทธิ์ (ระบบไม่คำนวณตามสัดส่วนเอง)',
  policy_period_not_confirmed: 'ยังไม่ได้ระบุช่วงบังคับใช้ของหลักเกณฑ์สำหรับปีงบประมาณนี้ จึงยังไม่คำนวณ',
  no_policy_for_period: 'หลักเกณฑ์นี้ยังไม่มีผลในปีงบประมาณนี้ จึงไม่คำนวณย้อนหลัง',
  policy_effective_mid_year: 'หลักเกณฑ์เริ่มมีผลกลางปีงบประมาณนี้ จึงยังไม่คำนวณทั้งปี',
  policy_unmapped: 'ประเภทบุคลากรนี้ยังไม่ได้กำหนดว่าใช้หลักเกณฑ์ใด',
  needs_hr: 'ต้องรอการยืนยันข้อมูลบุคลากร',
};

export function reasonsTh(row: LeaveBalanceRow): string[] {
  return (row.reasons ?? []).map((r) => REASON_TH[r]).filter((t): t is string => Boolean(t));
}

/** Months (YYYY-MM) of the fiscal year whose leave data is not imported yet, as พ.ศ. month/year text. */
export function uncoveredMonthsTh(row: LeaveBalanceRow): string | null {
  const months = row.uncoveredMonths ?? [];
  if (months.length === 0) return null;
  return months.map((m) => { const [y, mm] = m.split('-').map(Number); return `${mm}/${y + 543}`; }).join(', ');
}

/** Approved days used. While usage coverage is incomplete the figure is only a lower bound, so it is unknown ("—"), not a number. */
export function usedDaysDisplay(row: LeaveBalanceRow): number | null {
  if (row.usageComplete === false) return null;
  return row.usedDays ?? null;
}

// ---------------------------------------------------------------- organisation overview


export const LEAVE_KINDS: LeaveKind[] = ['sick', 'personal', 'vacation'];

const SCOPE_LABEL_TH: Record<EntitlementScope, string> = {
  in_policy: 'อยู่ในหลักเกณฑ์',
  unconfirmed: 'รอยืนยันสิทธิ์',
  excluded: 'อยู่นอกหลักเกณฑ์',
};
export function scopeLabelTh(scope: EntitlementScope): string {
  return SCOPE_LABEL_TH[scope] ?? 'ไม่มีข้อมูล';
}

/** What the engine still needs to know, as the owner would say it. Unknown codes fall back to a neutral text. */
const MISSING_LABEL_TH: Record<string, string> = {
  hireDate: 'วันที่เริ่มจ้าง',
  continuousServiceStart: 'วันที่เริ่มนับอายุงานต่อเนื่อง',
  appointmentKind: 'ลักษณะการบรรจุ',
  vacationCarryoverDays: 'วันลาพักผ่อนสะสมยกมา',
  holidayCalendar: 'ปฏิทินวันหยุด',
};
export function missingLabelTh(code: string): string {
  return MISSING_LABEL_TH[code] ?? 'ข้อมูลที่ยังไม่ครบ';
}

/** Review notes for flags the engine raises; they never change a number. Unknown flags show nothing. */
const FLAG_NOTE_TH: Record<string, string> = {
  medical_certificate_review: 'ตรวจใบรับรองแพทย์',
  carryover_not_allowed: 'หลักเกณฑ์นี้ไม่มียอดสะสม (ไม่นำยอดที่บันทึกไว้มาบวก)',
  vacation_half_day_review: 'ลาพักผ่อนน้อยกว่าขั้นต่ำของหลักเกณฑ์ รอตรวจสอบ',
  hr_differs_from_policy: 'สิทธิ์ที่กรอกต่างจากที่หลักเกณฑ์กำหนด',
};
export function flagNotesTh(cell: { flags?: string[] } | undefined): string[] {
  return [...new Set((cell?.flags ?? []).map((f) => FLAG_NOTE_TH[f]).filter((t): t is string => Boolean(t)))];
}

export const APPOINTMENT_KIND_TH: Record<string, string> = {
  first: 'บรรจุครั้งแรก',
  rehire_after_resignation: 'กลับเข้าทำงานหลังลาออก',
  rehire_after_dismissal: 'กลับเข้าทำงานหลังถูกให้ออก',
  other: 'อื่น ๆ',
};

/**
 * One table cell: the remaining days when the whole balance is determined; otherwise a status label and no
 * number. `of` is the determined total; never a 0 stand-in.
 */
export function cellView(cell: EntitlementCell | undefined): { text: string; sub: string | null; tone: 'ok' | 'wait' | 'none'; meter: number | null } {
  if (!cell) return { text: '—', sub: null, tone: 'none', meter: null };
  if (cell.status === 'out_of_scope') return { text: '—', sub: statusLabelTh(cell.status), tone: 'none', meter: null };
  if (cell.available && cell.remainingDays !== null) {
    return { text: formatDays(cell.remainingDays), sub: `จาก ${formatDays(cell.totalDays)}`, tone: 'ok', meter: usedPercent(cell) };
  }
  // What is missing, named per leave type; otherwise the reason the figure is withheld.
  const missing = cell.missing.map(missingLabelTh);
  let sub: string;
  if (missing.length) sub = `ขาด: ${missing.join(', ')}`;
  else if (cell.status === 'ok') sub = cell.usageComplete ? 'ยังคำนวณไม่ได้' : 'ข้อมูลการลาไม่ครบทุกเดือน'; // entitlement known, usage months missing
  else sub = statusLabelTh(cell.status);
  return { text: 'ไม่มีข้อมูล', sub, tone: 'wait', meter: null };
}

export interface OverviewFilter { query: string; scope: '' | EntitlementScope; division: string; missingOnly: boolean }

export function filterRows(rows: EntitlementRow[], f: OverviewFilter): EntitlementRow[] {
  const needle = f.query.trim().toLowerCase();
  return rows.filter((r) => (!needle || r.employeeId.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
    && (!f.scope || r.scope === f.scope)
    && (!f.division || r.division.code === f.division)
    && (!f.missingOnly || (r.scope !== 'excluded' && (r.missing.length > 0 || r.scope === 'unconfirmed'))));
}

/** Owner form day input: '' = not entered (null), a number in steps of 0.5 within [0, max], else 'invalid'. */
export function parseDaysInput(text: string, max: number): number | null | 'invalid' {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d)?$/.test(t)) return 'invalid';
  const n = Number(t);
  return n >= 0 && n <= max && Number.isInteger(n * 2) ? n : 'invalid';
}

// ---------------------------------------------------------------- import findings (rule codes -> Thai)

const FINDING_TH: Record<string, string> = {
  unknown_column: 'มีคอลัมน์ที่ไม่อยู่ในแบบฟอร์ม', missing_column: 'ขาดคอลัมน์ตามแบบฟอร์ม', duplicate_column: 'คอลัมน์ซ้ำ',
  too_many_rows: 'จำนวนแถวมากเกินไป', empty_file: 'ไฟล์ว่าง', unterminated_quote: 'ไฟล์มีเครื่องหมายคำพูดไม่ครบ',
  row_columns: 'จำนวนช่องในแถวไม่ตรงกับหัวตาราง', id_format: 'รหัสพนักงานต้องเป็นเลข 4 หลัก', id_duplicate: 'แถวซ้ำ', id_not_found: 'ไม่พบรหัสพนักงานนี้ในระบบ',
  not_active: 'พนักงานไม่ได้อยู่ในสถานะใช้งาน', type_mismatch: 'ประเภทบุคลากรไม่ตรงกับในระบบ', type_out_of_scope: 'พนักงานจ้างเหมาอยู่นอกประกาศ ไม่นำเข้า',
  name_mismatch: 'ชื่อไม่ตรงกับในระบบ (ตรวจรหัสอีกครั้ง)', date_format: 'รูปแบบวันที่ไม่ถูกต้อง', hire_in_future: 'วันที่เริ่มงานอยู่ในอนาคต',
  continuity_after_hire: 'วันเริ่มนับอายุงานต่อเนื่องหลังวันเริ่มงาน', appointment_kind_unknown: 'ประเภทการบรรจุไม่ถูกต้อง', appointment_kind_missing: 'ต้องระบุประเภทการบรรจุ (เริ่มงานตั้งแต่ 1 ต.ค. 2568)',
  confirmation_value: 'การยืนยันสิทธิ์ต้องเป็น ใช่ / ไม่ใช่', confirmation_needs_reference: 'การยืนยันสิทธิ์ต้องมีเลขที่หนังสือ/เหตุผล', source_missing: 'ต้องระบุแหล่งข้อมูล/เอกสารอ้างอิง',
  note_too_long: 'หมายเหตุยาวเกินไป', days_format: 'จำนวนวันต้องเป็นตัวเลขหลายเท่าของ 0.5', fiscal_year_range: 'ปีงบประมาณอยู่นอกช่วงที่รับ', leave_type_unknown: 'ประเภทการลาไม่ถูกต้อง',
  carryover_not_vacation: 'ยอดสะสมใช้กับลาพักผ่อนเท่านั้น', baseline_pair: 'ยอดที่ใช้ไปก่อนเริ่มนับต้องมาคู่กับวันที่ และอยู่ในปีงบประมาณเดียวกัน',
  no_data: 'ไม่มีข้อมูลในแถวนี้ (ข้าม)', hire_missing: 'ยังไม่ระบุวันที่เริ่มงาน', conflicts_with_existing: 'ค่าใหม่ต่างจากที่บันทึกไว้ (จะถูกแทนที่และบันทึกประวัติ)',
  eligibility_unconfirmed: 'ยังไม่ได้ยืนยันสิทธิ์ตามประกาศ', vacation_cap_exceeded: 'สิทธิ์ลาพักผ่อนรวมเกินเพดาน', differs_from_policy: 'ต่างจากที่ประกาศกำหนด',
};
export function findingLabelTh(code: string): string {
  return FINDING_TH[code] ?? 'ข้อมูลไม่ถูกต้อง';
}

/** Group findings by level + code with the line numbers (never the values), errors first. */
export function groupFindings(findings: { kind: string; line: number; level: string; code: string }[]): { level: string; kind: string; code: string; lines: number[] }[] {
  const map = new Map<string, { level: string; kind: string; code: string; lines: number[] }>();
  for (const f of findings) {
    const key = `${f.level}|${f.kind}|${f.code}`;
    if (!map.has(key)) map.set(key, { level: f.level, kind: f.kind, code: f.code, lines: [] });
    if (f.line > 0) map.get(key)!.lines.push(f.line);
  }
  return [...map.values()].sort((a, b) => (a.level === b.level ? a.code.localeCompare(b.code) : (a.level === 'error' ? -1 : 1)));
}

/** The confirm button is offered only after a clean dry run of exactly the files on screen. */
export function canConfirmImport(result: { mode: string; ok: boolean; blockingErrors: number; alreadyApplied: boolean; files: Record<string, { toApply: number; alreadyApplied: boolean } | undefined> } | null): boolean {
  if (!result || result.mode !== 'dry-run' || !result.ok || result.blockingErrors > 0 || result.alreadyApplied) return false;
  const files = Object.values(result.files).filter(Boolean) as { toApply: number; alreadyApplied: boolean }[];
  return files.some((f) => f.toApply > 0 && !f.alreadyApplied);
}

/** The label of a person's policy, or the plain note that none is mapped (the owner has to choose one). */
export function policyLabelTh(policy: { family: string | null; labelTh: string | null } | undefined): string {
  return policy?.labelTh ?? 'ยังไม่กำหนดหลักเกณฑ์การลา';
}

export const POLICY_FAMILIES: { key: 'university' | 'section_employee' | 'section_contract' | 'unmapped'; labelTh: string }[] = [
  { key: 'university', labelTh: 'พนักงานมหาวิทยาลัย' },
  { key: 'section_employee', labelTh: 'พนักงานส่วนงาน' },
  { key: 'section_contract', labelTh: 'พนักงานส่วนงานจ้างเหมา' },
  { key: 'unmapped', labelTh: 'ยังไม่กำหนดหลักเกณฑ์' },
];
