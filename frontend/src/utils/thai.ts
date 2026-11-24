export const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
] as const;

/** Buddhist-era year for display. The API and every calculation keep using the Gregorian year. */
export function buddhistYear(year: number): number {
  return year + 543;
}

const ROLE_LABELS: Record<string, string> = {
  executive: 'ผู้บริหาร',
  manager: 'หัวหน้า/ผู้จัดการ',
  admin: 'ผู้ดูแลระบบ (System admin)',
  user: 'พนักงาน',
};

export function roleLabel(role: string | undefined | null): string {
  return (role && ROLE_LABELS[role]) || 'พนักงาน';
}

/** Personnel type labels, confirmed by the owner's personnel file (01-updatedb2.csv). Unknown values are shown as stored. */
const EMPLOYEE_TYPE_LABELS: Record<string, string> = {
  university: 'พนักงานมหาวิทยาลัย',
  department: 'พนักงานส่วนงาน',
  contract: 'พนักงานส่วนงานจ้างเหมา',
  procurement_academic: 'นักวิชาการพัสดุ',
};

export function employeeTypeLabel(value: string | undefined | null): string {
  if (!value) return '—';
  return EMPLOYEE_TYPE_LABELS[value] ?? value;
}

const EMPLOYEE_STATUS_LABELS: Record<string, string> = {
  active: 'ปฏิบัติงานอยู่',
  inactive: 'ไม่ได้ปฏิบัติงาน',
  resigned: 'ลาออก',
};

export function employeeStatusLabel(value: string | undefined | null): string {
  if (!value) return '—';
  return EMPLOYEE_STATUS_LABELS[value] ?? value;
}

/** Leave request status as stored by the API. Only the three standard states are translated; anything else is shown as stored. */
export function leaveStatusLabel(value: string | undefined | null): string {
  if (!value) return '—';
  const map: Record<string, string> = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };
  return map[value.toLowerCase()] ?? value;
}

/** Chip class for the status of one leave record (approved / unverified / needs_review / rejected / legacy pending). */
export function leaveRecordChipClass(status: string): string {
  if (status === 'approved') return 'chip chip--ok';
  if (status === 'needs_review' || status === 'pending') return 'chip chip--late';
  if (status === 'rejected') return 'chip chip--muted';
  return 'chip chip--leave';
}

export type Tone = 'ok' | 'late' | 'leave' | 'muted';

/** Visual tone for a Thai status label already produced by the API (`statusLabel`). */
export function statusTone(label: string): Tone {
  if (label === 'มาทำงาน') return 'ok';
  if (label === 'สาย' || label === 'รออนุมัติ') return 'late';
  if (label === 'อนุมัติ') return 'ok';
  if (label === 'ลา' || label.startsWith('ลา')) return 'leave';
  return 'muted';
}

export const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Display an ISO (CE) date as Thai Buddhist Era. `numeric` → 20/11/2569, `short` → 20 พ.ย. 2569.
 * Anything that is not an ISO date is returned as stored. The ISO value itself is never changed.
 */
export function formatThaiDate(iso: string | null | undefined, style: 'numeric' | 'short' = 'short'): string {
  if (!iso) return '—';
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12) return iso;
  return style === 'numeric'
    ? `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${buddhistYear(year)}`
    : `${day} ${THAI_MONTHS_SHORT[month - 1]} ${buddhistYear(year)}`;
}

/** Year choices for a พ.ศ. dropdown, newest first. Values are พ.ศ.; convert with `gregorianYear`. */
export function buddhistYearOptions(currentCe: number, span = 6): number[] {
  const current = buddhistYear(currentCe);
  return Array.from({ length: span + 1 }, (_, i) => current - i);
}

export function gregorianYear(be: number): number {
  return be - 543;
}
