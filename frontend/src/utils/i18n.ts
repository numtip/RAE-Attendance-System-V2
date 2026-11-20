import { ApiError } from '../api/errors';

/** Single source of truth for leave type labels. Unknown codes are shown as stored. */
export const LEAVE_TYPE_LABELS: Record<string, string> = {
  personal: 'ลากิจ',
  sick: 'ลาป่วย',
  vacation: 'ลาพักผ่อน',
  other: 'ลาอื่น ๆ',
};

export function leaveTypeLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return LEAVE_TYPE_LABELS[code.toLowerCase()] ?? code;
}

export const GENERIC_ERROR_TH = 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';

/** API error codes → Thai. Checked first. */
const ERROR_CODE_TH: Record<string, string> = {
  EMPLOYEE_NOT_FOUND: 'ไม่พบข้อมูลพนักงาน',
  INVALID_CREDENTIALS: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  ACCOUNT_LOCKED: 'บัญชีนี้ถูกล็อก กรุณาติดต่อผู้ดูแลระบบ',
  UNAUTHORIZED: 'กรุณาเข้าสู่ระบบใหม่',
  ACCESS_TOKEN_REVOKED: 'กรุณาเข้าสู่ระบบใหม่',
  INVALID_REFRESH_TOKEN: 'กรุณาเข้าสู่ระบบใหม่',
  FORBIDDEN: 'ท่านไม่มีสิทธิ์เข้าถึงข้อมูลนี้',
  VALIDATION_ERROR: 'ข้อมูลที่ระบุไม่ถูกต้อง',
  EXPORT_INVALID_FORMAT: 'รูปแบบไฟล์ที่ส่งออกไม่ถูกต้อง',
  SSO_DENIED: 'การเข้าสู่ระบบด้วย MJU SSO ถูกปฏิเสธ',
  SSO_HANDOFF_INVALID: 'รหัสเข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่อีกครั้ง',
  SSO_TOKEN_ERROR: 'รหัสยืนยันจาก MJU SSO ไม่ถูกต้องหรือหมดอายุ',
  SSO_NOT_READY: 'ระบบ MJU SSO ยังไม่พร้อมใช้งาน',
  IDENTITY_NOT_APPROVED: 'บัญชีนี้ยังไม่ได้รับอนุมัติให้เข้าสู่ระบบ',
  IDENTITY_EMAIL_MISMATCH: 'อีเมลไม่ตรงกับข้อมูลพนักงาน',
  ATTENDANCE_CORE_TIMEOUT: 'ระบบใช้เวลาตอบสนองนานเกินไป กรุณาลองใหม่อีกครั้ง',
  ATTENDANCE_CORE_ERROR: 'ไม่สามารถเชื่อมต่อระบบข้อมูลลงเวลาได้',
  ATTENDANCE_CORE_UNAVAILABLE: 'ระบบข้อมูลลงเวลาไม่พร้อมใช้งาน',
};

/** Exact English API messages → Thai (used when the code is generic, e.g. NOT_FOUND). */
const ERROR_MESSAGE_TH: Record<string, string> = {
  'employee was not found': 'ไม่พบข้อมูลพนักงาน',
  'employee not found': 'ไม่พบข้อมูลพนักงาน',
  'monthly summary was not found': 'ไม่พบสรุปรายเดือน',
  'identity link was not found': 'ไม่พบข้อมูลการผูกบัญชี',
  'access token is required': 'กรุณาเข้าสู่ระบบใหม่',
  'access token is invalid': 'กรุณาเข้าสู่ระบบใหม่',
  'unexpected server error': GENERIC_ERROR_TH,
  'failed to fetch': 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง',
};

const NOT_FOUND_STATUS_TH = 'ไม่พบข้อมูลที่ต้องการ';

const THAI_CHAR = /[฀-๿]/;

/**
 * Thai text for any error shown to a user. Order: error code → known message → HTTP status →
 * message that is already Thai → generic fallback. Raw English API text is never displayed.
 */
export function errorMessageTh(e: unknown, fallback: string = GENERIC_ERROR_TH): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (e instanceof ApiError) {
    if (ERROR_CODE_TH[e.code]) return ERROR_CODE_TH[e.code];
    const byMessage = ERROR_MESSAGE_TH[e.message.trim().toLowerCase()];
    if (byMessage) return byMessage;
    if (e.status === 404) return NOT_FOUND_STATUS_TH;
    if (e.status === 403) return ERROR_CODE_TH.FORBIDDEN;
    if (e.status === 401) return ERROR_CODE_TH.UNAUTHORIZED;
  } else if (message) {
    const byMessage = ERROR_MESSAGE_TH[message.trim().toLowerCase()];
    if (byMessage) return byMessage;
  }
  if (message && THAI_CHAR.test(message)) return message;
  return fallback;
}
