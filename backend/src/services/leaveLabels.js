/** Thai labels shared by the leave report and the leave review screen. */
const PART_LABEL = { FULL: 'เต็มวัน', AM: 'ครึ่งวันเช้า', PM: 'ครึ่งวันบ่าย', UNKNOWN: 'ไม่ทราบช่วงเวลา' };
const REASON_LABEL = {
  both_scans_present: 'มีหมายเหตุลา แต่มีเวลาสแกนทั้งเข้าและออก',
  scan_contradicts_remark: 'เวลาสแกนขัดกับหมายเหตุ',
  scan_time_implausible: 'เวลาสแกนไม่สอดคล้องกับช่วงที่ลา',
  non_working_day: 'ตรงกับวันหยุด/วันที่ไม่ใช่วันทำงาน',
  multiple_leave_types: 'มีหมายเหตุการลามากกว่าหนึ่งประเภทในวันเดียว',
  conflicts_with_absent_flag: 'ขัดแย้งกับหมายเหตุอื่นของ HIP ในวันเดียวกัน',
  conflicts_with_official_duty: 'มีหมายเหตุไปราชการในวันเดียวกัน',
  duplicate_source_conflict: 'พบรายการซ้ำที่จัดประเภทไม่ตรงกัน',
};
const TYPE_LABEL = { personal: 'ลากิจ', sick: 'ลาป่วย', vacation: 'ลาพักผ่อน' };
const APPROVAL_LABEL = { unverified: 'ยังไม่ยืนยันอนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };

/**
 * Explicit status of one employee_leave_record row, derived only from stored columns:
 * rejected (decision) / needs_review (conflicting, never counted) / approved (executive decided) /
 * unverified (recorded from HIP or by hand, not yet decided).
 */
const RECORD_STATUS_LABEL = {
  approved: 'อนุมัติแล้ว',
  unverified: 'บันทึกแล้ว · รออนุมัติ',
  needs_review: 'รอตรวจสอบ',
  rejected: 'ไม่อนุมัติ',
};
const SOURCE_LABEL = { hip_daily_report_remark: 'รายงาน HIP (หมายเหตุ)', owner_manual_entry: 'บันทึกด้วยมือ', legacy: 'ระบบเดิม' };

function recordStatus(record) {
  if (record.approvalStatus === 'rejected') return 'rejected';
  if (record.reviewStatus !== 'candidate') return 'needs_review';
  return record.approvalStatus === 'approved' ? 'approved' : 'unverified';
}

module.exports = { PART_LABEL, REASON_LABEL, TYPE_LABEL, APPROVAL_LABEL, RECORD_STATUS_LABEL, SOURCE_LABEL, recordStatus };
