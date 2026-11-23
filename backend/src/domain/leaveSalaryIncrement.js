/**
 * Salary-increment leave indicator — deliberately SEPARATE from leave entitlement and balances.
 *
 * Source: the footnote of the sick / personal / maternity leave form (page 18 of the 2569 announcement):
 * "การลากิจ + ลาป่วย ต้องไม่เกิน ๔๕ วันทำการ จึงมีสิทธิเลื่อนค่าจ้าง". It is a form note about eligibility for a
 * salary increment, not an article of the announcement and not a leave entitlement. Nothing here feeds
 * leavePolicyEngine, and the engine never reads this: a person above 45 days still has paid sick leave and
 * personal leave under their own allowances; they are only flagged for the (HR-owned) increment decision.
 *
 * Informational only: HR has not confirmed which approval states, which leave kinds or which fiscal year the
 * increment review uses, so the result carries `authoritative: false`.
 */

const THRESHOLD_WORKING_DAYS = 45;

/** Approved sick + personal working days in one fiscal year (YYYY-MM-DD bounds), each record as recorded. */
function salaryIncrementLeaveIndicator(records, fiscalYear) {
  let sick = 0;
  let personal = 0;
  for (const row of records || []) {
    if (!row || row.status !== 'approved' || typeof row.dayFraction !== 'number') continue;
    if (row.date < fiscalYear.start || row.date > fiscalYear.end) continue;
    if (row.leaveType === 'sick') sick += row.dayFraction;
    else if (row.leaveType === 'personal') personal += row.dayFraction;
  }
  const combined = sick + personal;
  return {
    purpose: 'salary_increment_indicator_not_a_leave_balance',
    authoritative: false,
    source: 'leave form footnote, page 18',
    thresholdWorkingDays: THRESHOLD_WORKING_DAYS,
    sickWorkingDays: sick,
    personalWorkingDays: personal,
    combinedWorkingDays: combined,
    withinThreshold: combined <= THRESHOLD_WORKING_DAYS,
  };
}

module.exports = { salaryIncrementLeaveIndicator, THRESHOLD_WORKING_DAYS };
