/**
 * Organization identity — the one place the display name lives (exports, API metadata).
 * It is NOT an employee's department or org-unit: those are per-employee records (employees.department,
 * employee_org_membership) and are never derived from or overwritten by these constants.
 */
module.exports = Object.freeze({
  ORGANIZATION_NAME_TH: 'สำนักวิจัยและส่งเสริมวิชาการการเกษตร',
  INSTITUTION_NAME_TH: 'มหาวิทยาลัยแม่โจ้',
  SYSTEM_NAME_TH: 'ระบบลงเวลาปฏิบัติงาน',
  /**
   * The three divisions. `code` is the org_unit_code stored in employee_org_membership and used by
   * MANAGER org-unit grants, so RBAC and this dashboard share one vocabulary. Names follow the HIP
   * roster ("แผนก" column), which is the HR evidence the mapping was validated against.
   */
  DIVISIONS: Object.freeze([
    Object.freeze({ code: 'DIV_OFFICE', nameTh: 'กองบริหารงานสำนักวิจัยฯ' }),
    Object.freeze({ code: 'DIV_RESEARCH', nameTh: 'กองบริหารงานวิจัย' }),
    Object.freeze({ code: 'DIV_ACADEMIC_SERVICE', nameTh: 'กองบริหารงานบริการวิชาการ' }),
  ]),
});
