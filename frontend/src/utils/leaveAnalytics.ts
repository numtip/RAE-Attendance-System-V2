import type { LeaveKind, LeaveMonthlyReport, LeaveRecordItem } from '../api/types';

/** One colour per leave type; light-theme, colour-blind-distinguishable, reused by strip, bars and legend. */
export const LEAVE_KIND_COLOR: Record<LeaveKind, string> = {
  vacation: '#2f6fdb',
  sick: '#0f9d7a',
  personal: '#e0702f',
};

export function formatDays(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export const NO_DATA = 'ไม่มีข้อมูล';

export interface TypeSlice { type: LeaveKind; label: string; days: number; color: string; share: number }

/** Recorded days per leave type, with each type's share of the recorded total (0..1). */
export function typeSlices(report: LeaveMonthlyReport): TypeSlice[] {
  const totals = report.recordedTotals;
  if (!totals) return [];
  const sum = report.types.reduce((acc, t) => acc + totals.byType[t.type].days, 0);
  return report.types.map((t) => {
    const days = totals.byType[t.type].days;
    return { type: t.type, label: t.labelTh, days, color: LEAVE_KIND_COLOR[t.type], share: sum > 0 ? days / sum : 0 };
  });
}

export interface MonthPoint {
  month: string; // YYYY-MM
  label: string;
  /** null = the month was never imported (NOT zero). */
  days: number | null;
  approvedDays: number | null;
  awaitingDays: number | null;
}

/**
 * Monthly trend from a whole-year report's records. Months listed in
 * `recordedCoverage.uncoveredMonths` have no imported data and stay null.
 */
export function monthlyTrend(report: LeaveMonthlyReport, monthNames: readonly string[]): MonthPoint[] {
  const uncovered = new Set(report.recordedCoverage.uncoveredMonths);
  const points: MonthPoint[] = [];
  const startMonth = Number(report.from.slice(5, 7));
  const endMonth = Number(report.to.slice(5, 7));
  for (let m = startMonth; m <= endMonth; m += 1) {
    const key = `${report.year}-${String(m).padStart(2, '0')}`;
    const noData = uncovered.has(key);
    points.push({ month: key, label: monthNames[m - 1] ?? key, days: noData ? null : 0, approvedDays: noData ? null : 0, awaitingDays: noData ? null : 0 });
  }
  const byKey = new Map(points.map((p) => [p.month, p]));
  for (const r of report.records) addRecord(byKey.get(r.date.slice(0, 7)), r);
  return points;
}

function addRecord(point: MonthPoint | undefined, r: LeaveRecordItem) {
  if (!point || point.days === null || r.dayFraction === null) return; // needs_review/rejected carry no day value
  if (r.status === 'rejected' || r.status === 'needs_review') return;
  point.days += r.dayFraction;
  if (r.status === 'approved') point.approvedDays = (point.approvedDays ?? 0) + r.dayFraction;
  else point.awaitingDays = (point.awaitingDays ?? 0) + r.dayFraction;
}

export interface PersonStat {
  employeeUid: string;
  employeeId: string;
  employeeName: string;
  divisionName: string;
  /** null = month(s) not imported. */
  recordedDays: number | null;
  approvedDays: number | null;
  awaitingDays: number | null;
  needsReview: number | null;
  byType: { type: LeaveKind; label: string; days: number | null; color: string }[];
}

export function personStats(report: LeaveMonthlyReport): PersonStat[] {
  return report.rows
    .map((row) => ({
      employeeUid: row.employeeUid,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      divisionName: row.divisionName,
      recordedDays: row.recordedTotals ? row.recordedTotals.recordedDays : null,
      approvedDays: row.recordedTotals ? row.recordedTotals.approvedDays : null,
      awaitingDays: row.recordedTotals ? row.recordedTotals.awaitingApprovalDays : null,
      needsReview: row.recordedNeedsReview,
      byType: report.types.map((t) => ({
        type: t.type,
        label: t.labelTh,
        days: row.recorded ? row.recorded[t.type].days : null,
        color: LEAVE_KIND_COLOR[t.type],
      })),
    }))
    .sort((a, b) => (b.recordedDays ?? -1) - (a.recordedDays ?? -1) || a.employeeName.localeCompare(b.employeeName, 'th'));
}

export interface ReviewIssue { key: string; tone: 'late' | 'info' | 'muted'; title: string; detail: string }

/** Data-quality / pending-review items, every one derived from the report itself. */
export function reviewIssues(report: LeaveMonthlyReport): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const all = report.recordedTotals?.all;
  if (report.recordedCoverage.uncoveredMonths.length) {
    issues.push({ key: 'uncovered', tone: 'muted', title: 'เดือนที่ยังไม่มีข้อมูล HIP', detail: `${report.recordedCoverage.uncoveredMonths.length} เดือน (${report.recordedCoverage.uncoveredMonths.join(', ')}) — ไม่ได้หมายความว่าไม่มีผู้ลา` });
  }
  if (report.dataThrough?.partial && report.dataThrough.note) {
    issues.push({ key: 'partial', tone: 'late', title: 'ข้อมูลเดือนนี้ยังไม่ครบ', detail: report.dataThrough.note });
  }
  if (all?.needsReviewRecords) issues.push({ key: 'needs-review', tone: 'late', title: 'รอตรวจสอบ', detail: `${all.needsReviewRecords} รายการ — ไม่รวมในยอดวัน จนกว่าผู้บริหารตรวจสอบ` });
  if (all?.rejectedRecords) issues.push({ key: 'rejected', tone: 'muted', title: 'ไม่อนุมัติ', detail: `${all.rejectedRecords} รายการ — ไม่รวมในยอดวัน` });
  if (all && all.awaitingApprovalDays > 0) issues.push({ key: 'awaiting', tone: 'info', title: 'รออนุมัติ', detail: `${formatDays(all.awaitingApprovalDays)} วัน บันทึกแล้วแต่ยังไม่ผ่านการอนุมัติ` });
  if (report.coverage.unmatchedRecordsExcluded) issues.push({ key: 'unmatched', tone: 'late', title: 'รายการที่จับคู่พนักงานไม่ได้', detail: `${report.coverage.unmatchedRecordsExcluded} รายการ (ระบบเดิม) ถูกตัดออกจากยอด` });
  if (!report.reconciliation.reconciled) issues.push({ key: 'recon', tone: 'late', title: 'ยอดไม่ตรงกัน', detail: 'ผลรวมรายบุคคล/รายกอง/รายละเอียดไม่ตรงกัน — โปรดแจ้งผู้ดูแลระบบ' });
  return issues;
}
