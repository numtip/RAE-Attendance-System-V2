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
  pending_hr_decision: 'รอตีความนโยบาย',
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
  in_policy: 'อยู่ในประกาศ',
  unconfirmed: 'รอยืนยันสิทธิ์',
  excluded: 'อยู่นอกประกาศ',
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
  // Status ok but no remaining figure: the entitlement is known, the usage is not (months missing from the leave import).
  const sub = cell.status === 'ok' ? (cell.usageComplete ? 'ยังคำนวณไม่ได้' : 'ข้อมูลการลาไม่ครบทุกเดือน') : statusLabelTh(cell.status);
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
