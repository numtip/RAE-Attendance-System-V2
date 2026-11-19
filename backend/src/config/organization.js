/**
 * Organization identity — the one place the display name lives (exports, API metadata).
 * It is NOT an employee's department or org-unit: those are per-employee records (employees.department,
 * employee_org_membership) and are never derived from or overwritten by these constants.
 */
module.exports = Object.freeze({
  ORGANIZATION_NAME_TH: 'สำนักวิจัยและส่งเสริมวิชาการการเกษตร',
  INSTITUTION_NAME_TH: 'มหาวิทยาลัยแม่โจ้',
  SYSTEM_NAME_TH: 'ระบบลงเวลาปฏิบัติงาน',
});
