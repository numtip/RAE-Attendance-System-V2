import type { LeaveBalanceRow } from '../api/types';

/** Fiscal year (พ.ศ.) the entitlement screen opens on: FY2570 = 2026-10-01 .. 2027-09-30. */
export const DEFAULT_FISCAL_YEAR_BE = 2570;
/** The engine's own bounds (migration 035 / leaveService): earlier or later years are refused by the API. */
export const MIN_FISCAL_YEAR_BE = 2569;
export const MAX_FISCAL_YEAR_BE = 2700;

export type BalanceBasis = 'calendar' | 'fiscal';

const STATUS_LABEL_TH: Record<string, string> = {
  ok: 'คำนวณสิทธิ์แล้ว',
  needs_hr: 'รอข้อมูลยืนยันจาก HR',
  pending_hr_decision: 'รอ HR พิจารณา',
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
export function isMeterValid(row: LeaveBalanceRow): boolean {
  if (!row.available) return false;
  if (row.status !== undefined && row.status !== 'ok') return false;
  if (row.usageComplete === false) return false;
  return row.totalDays !== null && row.totalDays > 0 && row.usedDays !== null && row.remainingDays !== null;
}

export function usedPercent(row: LeaveBalanceRow): number | null {
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
  needs_hr: 'ต้องรอข้อมูลที่ HR ยืนยัน',
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
