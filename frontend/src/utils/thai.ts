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
  admin: 'ผู้ดูแลระบบ',
  user: 'พนักงาน',
};

export function roleLabel(role: string | undefined | null): string {
  return (role && ROLE_LABELS[role]) || 'พนักงาน';
}

/** Only values the owner has confirmed are translated; anything else is shown as stored. */
export function employeeTypeLabel(value: string | undefined | null): string {
  if (!value) return '—';
  return value === 'contract' ? 'พนักงานส่วนงานจ้างเหมา' : value;
}

export function employeeStatusLabel(value: string | undefined | null): string {
  if (!value) return '—';
  return value === 'active' ? 'ปฏิบัติงานอยู่' : value;
}

/** Leave request status as stored by the API. Only the three standard states are translated; anything else is shown as stored. */
export function leaveStatusLabel(value: string | undefined | null): string {
  if (!value) return '—';
  const map: Record<string, string> = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };
  return map[value.toLowerCase()] ?? value;
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
