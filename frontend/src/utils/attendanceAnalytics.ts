import type { AttendanceAnalyticsReport, AttendanceAnalyticsRow, AttendanceMonthCoverage } from '../api/types';

export const NO_DATA = 'ไม่มีข้อมูล';

/**
 * Completeness as a label: null = no covered denominator at all (never shown as 0%),
 * a ratio renders rounded up to whole percent, 1 clamps to 100%.
 */
export function completenessLabel(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return NO_DATA;
  const percent = Math.round(ratio * 100);
  return `${Math.min(100, Math.max(0, percent))}%`;
}

/** Visual tone for completeness: >=90% healthy, >=70% watch, otherwise late-coloured. */
export function completenessTone(ratio: number | null): 'ok' | 'late' | 'muted' {
  if (ratio === null) return 'muted';
  if (ratio >= 0.9) return 'ok';
  if (ratio >= 0.7) return 'late';
  return 'late';
}

/** Minutes as Thai text; >= 1 hour reads "1 ชม. 35 นาที", zero is a real zero, not missing data. */
export function formatLateMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return NO_DATA;
  const value = Math.round(minutes);
  if (value < 60) return `${value} นาที`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} ชม. ${rest} นาที` : `${hours} ชม.`;
}

export interface AnalyticsTrendPoint {
  month: string;
  label: string;
  /** null = the month has no imported data (NOT zero). */
  lateArrivals: number | null;
  earlyDepartures: number | null;
  workdays: number | null;
  completeness: number | null;
  partial: boolean;
}

/**
 * Monthly trend straight from the report's own coverage months, so a whole-year view and a
 * single-month view both draw from the same reconciled source. Uncovered months stay null.
 * `shortMonthNames` is the caller's Thai month table (same pattern as `monthlyTrend`).
 */
export function analyticsTrend(report: AttendanceAnalyticsReport, shortMonthNames: readonly string[]): AnalyticsTrendPoint[] {
  return report.coverage.months.map((m: AttendanceMonthCoverage) => ({
    month: m.month,
    label: shortMonthNames[Number(m.month.slice(5, 7)) - 1] ?? m.month,
    lateArrivals: m.covered ? m.lateArrivals : null,
    earlyDepartures: m.covered ? m.earlyDepartures : null,
    workdays: m.covered ? m.workdays : null,
    completeness: m.completeness,
    partial: m.partial,
  }));
}

const trendMaxOf = (points: AnalyticsTrendPoint[], key: 'lateArrivals' | 'earlyDepartures' | 'workdays'): number => Math.max(0, ...points.map((p) => p[key] ?? 0));

/** The y-scale for the late/early trend: the larger of the two series' maxima. */
export function trendMax(points: AnalyticsTrendPoint[]): number {
  return Math.max(trendMaxOf(points, 'lateArrivals'), trendMaxOf(points, 'earlyDepartures'));
}

/** Top N people by recorded workdays (for the overview bar chart); never leaks out-of-scope rows. */
export function topPeopleByWorkdays(report: AttendanceAnalyticsReport, limit: number): AttendanceAnalyticsRow[] {
  return [...report.rows]
    .sort((a, b) => b.workdays - a.workdays || a.employeeName.localeCompare(b.employeeName, 'th'))
    .slice(0, limit);
}

/** Top N people by late arrivals, then late minutes (the "who is chronically late" chart). */
export function topPeopleByLateness(report: AttendanceAnalyticsReport, limit: number): AttendanceAnalyticsRow[] {
  return [...report.rows]
    .filter((row) => row.lateArrivals > 0)
    .sort((a, b) => b.lateArrivals - a.lateArrivals || b.lateMinutes - a.lateMinutes
      || a.employeeName.localeCompare(b.employeeName, 'th'))
    .slice(0, limit);
}

/** Case-insensitive substring match on id or name for the people table search. */
export function matchesSearch(row: AttendanceAnalyticsRow, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return row.employeeId.toLowerCase().includes(q) || row.employeeName.toLowerCase().includes(q);
}

/** Full Thai month label for a coverage row ("2026-11" → "พฤศจิกายน 2569"), given the month table. */
export function monthLabelTh(month: string, monthNames: readonly string[]): string {
  const index = Number(month.slice(5, 7)) - 1;
  const year = Number(month.slice(0, 4)) + 543;
  return `${monthNames[index] ?? month} ${year}`;
}
