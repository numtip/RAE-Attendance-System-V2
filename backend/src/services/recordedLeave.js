/**
 * HIP-recorded leave (employee_leave_record) as per-employee month totals, for reports that show a
 * single "leave" figure. `covered` is false when no HIP source was imported for that month, so callers
 * can show "no data" instead of 0. Only `candidate` rows add days (0.5 / 1.0); `needs_review` rows are
 * counted separately and never summed. These are HIP-derived records, not approved leave.
 */
async function recordedLeaveByEmployee(repositories, year, month, start, end) {
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const covered = (await repositories.leaveRecords.coveredPeriods()).includes(period);
  const byUid = new Map();
  if (!covered) return { covered, byUid };
  for (const row of await repositories.leaveRecords.listBetween(start, end)) {
    const entry = byUid.get(row.employeeUid) || { days: 0, needsReview: 0 };
    if (row.reviewStatus === 'candidate') entry.days += Number(row.dayFraction);
    else entry.needsReview += 1;
    byUid.set(row.employeeUid, entry);
  }
  return { covered, byUid };
}

module.exports = { recordedLeaveByEmployee };
