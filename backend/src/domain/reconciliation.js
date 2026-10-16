/**
 * R-04 reconciliation check model. PURE: no I/O, no database, no clock, no randomness.
 *
 * Reconciliation COMPARES stored facts; it never computes a new attendance truth and never writes. The
 * service reads the stores and hands this module plain, already-read observations; every rule about what a
 * check means lives here so it can be unit-tested without a repository.
 *
 * Snapshot status derivation (deterministic precedence):
 *
 *     blocked  >  mismatched  >  incomplete  >  matched
 *
 *   blocked      reconciliation cannot proceed: identity unresolvable/ambiguous, or a required source is
 *                unavailable (for example the events repository is absent). Nothing can be concluded.
 *   mismatched   a factual disagreement between the canonical row and the source records.
 *   incomplete   no disagreement found, but the period cannot be judged in full (unjudged days, no
 *                approved rule, missing scans, a month that was never derived).
 *   matched      every check passed.
 *
 * A period with NO checks / NO rows is `incomplete`, never `matched`: "nothing to compare" is not
 * agreement. This is the same trap E26 guards on the monthly side and it is pinned by a test.
 */
const CHECK_STATUS = Object.freeze(['matched', 'mismatched', 'incomplete', 'blocked']);

/** Higher = worse. `verdictOf` returns the worst status present. */
const STATUS_SEVERITY = Object.freeze({
  matched: 0,
  incomplete: 1,
  mismatched: 2,
  blocked: 3,
});

/** Canonical computation statuses the engine may store on a daily row (migration 023 + daily domain). */
const KNOWN_COMPUTATION_STATUSES = Object.freeze([
  'calculated',
  'no_data',
  'insufficient_data',
  'pending_policy',
  'failed',
]);

/** Daily computation statuses that mean "this day could not be judged" (mirrors Slice 3). */
const UNJUDGED_COMPUTATION_STATUSES = Object.freeze(['pending_policy', 'insufficient_data', 'failed']);

/** Fields compared between a stored monthly_summary and the figure re-derived from the canonical rows. */
const MONTH_TOTAL_FIELDS = Object.freeze([
  'totalWorkDays',
  'totalPresent',
  'totalLate',
  'totalAbsent',
  'totalLeave',
  'totalLateMinutes',
  'totalEarlyMinutes',
  'totalWorkHours',
  'pendingDays',
  'holidayDays',
]);

/** The fields the R-02 report publishes that a reconciliation compares against the stored month row. */
const REPORT_TOTAL_FIELDS = Object.freeze([
  'totalWorkDays',
  'totalPresent',
  'totalLate',
  'totalAbsent',
  'totalLeave',
  'totalLateMinutes',
  'totalEarlyMinutes',
  'totalWorkHours',
  'pendingDays',
  'holidayDays',
]);

/**
 * Stated plainly in the payload, not only in a doc: the V2 records are the only source that exists here.
 * The FY2569 evidence in the sibling project `numtip/Attendance-Report` has been TRANSCRIBED into test-only
 * fixtures (R-04-C), but NO external source was integrated at RUNTIME and reconciliation reads nothing
 * external. So the flag stays false until a real source is read here. A test asserts this stays false until
 * then, so it cannot silently become true.
 *
 * The wording below was corrected on 2026-10-16 (R-04-C): "was available or consulted" was stale once the
 * reference project was confirmed to exist. The honest statement is "was NOT integrated".
 */
const REAL_SOURCE_NOTE = 'Reconciled against stored V2 records only. The external FY2569 source (e.g. the '
  + 'attendance-report-generator reference) was NOT integrated, so this snapshot does NOT verify the '
  + 'original HIP/MJU source data.';

function makeCheck(code, status, { observed = null, expected = null, detail = null } = {}) {
  if (!CHECK_STATUS.includes(status)) {
    throw new Error(`unknown reconciliation check status: ${status}`);
  }
  return { code, status, observed, expected, detail, severity: STATUS_SEVERITY[status] };
}

/** The worst status among the checks. An empty list (nothing comparable) is `incomplete`, never `matched`. */
function verdictOf(checks = []) {
  let worst = null;
  for (const check of Array.isArray(checks) ? checks : []) {
    const status = String(check?.status ?? '');
    if (!Object.prototype.hasOwnProperty.call(STATUS_SEVERITY, status)) continue;
    if (worst == null || STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst ?? 'incomplete';
}

function countCheckStatuses(checks = []) {
  const counts = { matched: 0, mismatched: 0, incomplete: 0, blocked: 0 };
  for (const check of Array.isArray(checks) ? checks : []) {
    if (Object.prototype.hasOwnProperty.call(counts, check?.status)) counts[check.status] += 1;
  }
  return counts;
}

/** Every check that is not `matched`, trimmed to what a reviewer needs (never the whole row). */
function unresolvedChecks(checks = []) {
  return (Array.isArray(checks) ? checks : [])
    .filter((check) => check && check.status !== 'matched')
    .map((check) => ({
      code: check.code,
      status: check.status,
      detail: check.detail ?? null,
      observed: check.observed ?? null,
      expected: check.expected ?? null,
    }));
}

/** Short machine-stable reasons for a non-matched snapshot (the check code plus its detail). */
function statusReasonsOf(checks = []) {
  return unresolvedChecks(checks).map((check) => `${check.code}:${check.detail ?? check.status}`);
}

function numericEqual(a, b) {
  if (a == null && b == null) return true;
  return Number(a) === Number(b);
}

/** Compares a set of numeric fields, returning the differing field names (sorted). */
function differingFields(left, right, fields) {
  const differing = [];
  for (const field of fields) {
    if (!numericEqual(left?.[field], right?.[field])) differing.push(field);
  }
  return differing;
}

// ---------------------------------------------------------------------------
// day-level checks
// ---------------------------------------------------------------------------

/**
 * @param {object} obs a plain observation assembled by the service (no repository objects).
 * @returns {Array} the day-level checks.
 */
function evaluateDayChecks(obs = {}) {
  const {
    canonical = null,
    events = {},
    identity = {},
    rule = {},
    holiday = false,
    leave = {},
    workDayExpected = null,
  } = obs;
  const checks = [];
  const attributed = Array.isArray(events.attributed) ? events.attributed : [];

  // 1. identity: employee_uid plus effective-dated identifier/assignment windows. Ambiguity is FLAGGED.
  if (identity.conflict === true) {
    checks.push(makeCheck('employee_identity', 'blocked', {
      observed: 'conflict',
      expected: 'one_owner',
      detail: 'identity_conflict',
    }));
  } else if (identity.assignmentAmbiguous === true) {
    checks.push(makeCheck('employee_identity', 'blocked', {
      observed: identity.assignmentCount ?? null,
      expected: 1,
      detail: 'identity_ambiguous',
    }));
  } else {
    const identifiers = Number(identity.effectiveIdentifierCount) || 0;
    const assignments = Number(identity.assignmentCount) || 0;
    if (identifiers > 0 || assignments > 0) {
      checks.push(makeCheck('employee_identity', 'matched', {
        observed: { identifiers, assignments },
        expected: 'identifier_or_assignment_effective',
        detail: 'identity_effective',
      }));
    } else if (identity.available === false) {
      checks.push(makeCheck('employee_identity', 'blocked', {
        observed: 0,
        expected: 'identity_source',
        detail: 'identity_source_unavailable',
      }));
    } else {
      checks.push(makeCheck('employee_identity', 'blocked', {
        observed: 0,
        expected: 'identifier_or_assignment_effective',
        detail: 'identity_missing',
      }));
    }
  }

  // 2. approved_rule
  if (rule.approved) {
    checks.push(makeCheck('approved_rule', 'matched', {
      observed: rule.approved.ruleVersionCode ?? null,
      expected: 'approved_rule_effective',
      detail: 'rule_approved',
    }));
  } else if (rule.anyStatus) {
    checks.push(makeCheck('approved_rule', 'incomplete', {
      observed: rule.anyStatus.ruleVersionCode ?? null,
      expected: 'approved_rule_effective',
      detail: 'rule_pending_approval',
    }));
  } else {
    checks.push(makeCheck('approved_rule', 'incomplete', {
      observed: null,
      expected: 'approved_rule_effective',
      detail: 'no_rule_effective',
    }));
  }

  // 3. scan_presence
  if (events.available !== true) {
    checks.push(makeCheck('scan_presence', 'blocked', {
      observed: null,
      expected: 'events_source',
      detail: 'events_source_unavailable',
    }));
  } else if (attributed.length > 0) {
    checks.push(makeCheck('scan_presence', 'matched', {
      observed: attributed.length,
      expected: 'scans_present_or_absent_agreed',
      detail: 'scans_present',
    }));
  } else if (canonical && Number(canonical.sourceEventCount) > 0) {
    checks.push(makeCheck('scan_presence', 'mismatched', {
      observed: 0,
      expected: Number(canonical.sourceEventCount),
      detail: 'events_missing_for_canonical',
    }));
  } else if (canonical == null) {
    checks.push(makeCheck('scan_presence', 'incomplete', {
      observed: 0,
      expected: 'canonical_row',
      detail: 'no_scans_and_no_canonical_row',
    }));
  } else {
    checks.push(makeCheck('scan_presence', 'matched', {
      observed: 0,
      expected: 0,
      detail: 'no_scans_agreed',
    }));
  }

  // 4. scan_count: canonical sourceEventCount vs the UNIQUE scans attributable to this employee/day.
  if (events.available !== true) {
    checks.push(makeCheck('scan_count', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else if (canonical == null) {
    checks.push(makeCheck('scan_count', 'incomplete', {
      observed: attributed.length, expected: 'canonical_row', detail: 'no_canonical_row',
    }));
  } else {
    const canonicalCount = Number(canonical.sourceEventCount) || 0;
    const uniqueCount = Number(events.uniqueCount) || 0;
    checks.push(makeCheck('scan_count', canonicalCount === uniqueCount ? 'matched' : 'mismatched', {
      observed: uniqueCount,
      expected: canonicalCount,
      detail: canonicalCount === uniqueCount ? 'scan_count_agrees' : 'scan_count_differs',
    }));
  }

  // 5. event_span: canonical first/last wall timestamp vs min/max recomputed from the attributed scans.
  if (events.available !== true) {
    checks.push(makeCheck('event_span', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else if (canonical == null) {
    checks.push(makeCheck('event_span', 'incomplete', {
      observed: null, expected: 'canonical_row', detail: 'no_canonical_row',
    }));
  } else {
    const walls = attributed.map((event) => String(event.wall)).filter(Boolean).sort();
    const firstWall = walls.length > 0 ? walls[0] : null;
    const lastWall = walls.length > 0 ? walls[walls.length - 1] : null;
    const canonicalFirst = canonical.firstEventAt ?? null;
    const canonicalLast = canonical.lastEventAt ?? null;
    const agrees = firstWall === canonicalFirst && lastWall === canonicalLast;
    checks.push(makeCheck('event_span', agrees ? 'matched' : 'mismatched', {
      observed: { firstEventAt: firstWall, lastEventAt: lastWall },
      expected: { firstEventAt: canonicalFirst, lastEventAt: canonicalLast },
      detail: agrees ? 'event_span_agrees' : 'event_span_differs',
    }));
  }

  // 6. duplicate_scans: identical timestamp+checkType duplicates are a device artefact, reported not fatal.
  if (events.available !== true) {
    checks.push(makeCheck('duplicate_scans', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else {
    const duplicateCount = attributed.length - (Number(events.uniqueCount) || 0);
    checks.push(makeCheck('duplicate_scans', duplicateCount > 0 ? 'incomplete' : 'matched', {
      observed: duplicateCount,
      expected: 0,
      detail: duplicateCount > 0 ? 'duplicate_scans_present' : 'no_duplicate_scans',
    }));
  }

  // 7. unattributed_events: scans on the date with no employee attribution at all.
  if (events.unattributedCount == null) {
    checks.push(makeCheck('unattributed_events', 'incomplete', {
      observed: null, expected: 0, detail: 'unattributed_source_unavailable',
    }));
  } else if (Number(events.unattributedCount) > 0) {
    checks.push(makeCheck('unattributed_events', 'incomplete', {
      observed: Number(events.unattributedCount), expected: 0, detail: 'unattributed_events_present',
    }));
  } else {
    checks.push(makeCheck('unattributed_events', 'matched', {
      observed: 0, expected: 0, detail: 'no_unattributed_events',
    }));
  }

  // 8. foreign_events: scans attributed to a DIFFERENT employee in range. NEVER reassigned.
  if (events.available !== true) {
    checks.push(makeCheck('foreign_events', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else if (Number(events.foreignCount) > 0) {
    checks.push(makeCheck('foreign_events', 'incomplete', {
      observed: Number(events.foreignCount), expected: 0, detail: 'foreign_events_present_never_reassigned',
    }));
  } else {
    checks.push(makeCheck('foreign_events', 'matched', {
      observed: 0, expected: 0, detail: 'no_foreign_events',
    }));
  }

  // 9. leave_agreement: canonical isLeave vs a verified (approved + matched) leave row covering the date.
  if (leave.sourceAvailable !== true) {
    checks.push(makeCheck('leave_agreement', 'incomplete', {
      observed: null, expected: null, detail: 'leave_source_unavailable',
    }));
  } else {
    const verifiedLeave = Number(leave.verifiedCount) > 0;
    const canonicalIsLeave = canonical?.isLeave === true;
    if (canonical == null) {
      checks.push(makeCheck('leave_agreement', 'incomplete', {
        observed: verifiedLeave, expected: 'canonical_row', detail: 'no_canonical_row',
      }));
    } else if (verifiedLeave && canonicalIsLeave) {
      checks.push(makeCheck('leave_agreement', 'matched', {
        observed: true, expected: true, detail: 'leave_agrees',
      }));
    } else if (verifiedLeave && !canonicalIsLeave) {
      checks.push(makeCheck('leave_agreement', 'mismatched', {
        observed: false, expected: true, detail: 'leave_not_recorded',
      }));
    } else if (!verifiedLeave && canonicalIsLeave) {
      checks.push(makeCheck('leave_agreement', 'mismatched', {
        observed: true, expected: false, detail: 'leave_without_verified_fact',
      }));
    } else {
      checks.push(makeCheck('leave_agreement', 'matched', {
        observed: false, expected: false, detail: 'no_leave_agreed',
      }));
    }
  }

  // 10. workday_classification: canonical dayClassification vs the approved rule + approved holiday.
  if (canonical == null) {
    checks.push(makeCheck('workday_classification', 'incomplete', {
      observed: null, expected: null, detail: 'no_canonical_row',
    }));
  } else if (!rule.approved) {
    checks.push(makeCheck('workday_classification', 'incomplete', {
      observed: canonical.dayClassification ?? null, expected: 'approved_rule', detail: 'no_approved_rule',
    }));
  } else {
    const expected = holiday === true ? 'holiday' : (workDayExpected === true ? 'workday' : 'weekend');
    const observed = canonical.dayClassification ?? null;
    checks.push(makeCheck('workday_classification', observed === expected ? 'matched' : 'mismatched', {
      observed, expected, detail: observed === expected ? 'classification_agrees' : 'classification_differs',
    }));
  }

  // 11. computation_status: the canonical computationStatus must be a value the engine can produce.
  if (canonical == null) {
    checks.push(makeCheck('computation_status', 'incomplete', {
      observed: null, expected: KNOWN_COMPUTATION_STATUSES, detail: 'no_canonical_row',
    }));
  } else if (KNOWN_COMPUTATION_STATUSES.includes(String(canonical.computationStatus))) {
    checks.push(makeCheck('computation_status', 'matched', {
      observed: canonical.computationStatus, expected: KNOWN_COMPUTATION_STATUSES, detail: 'known_status',
    }));
  } else {
    checks.push(makeCheck('computation_status', 'mismatched', {
      observed: canonical.computationStatus ?? null,
      expected: KNOWN_COMPUTATION_STATUSES,
      detail: 'unknown_computation_status',
    }));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// period-level checks (month and fiscal year)
// ---------------------------------------------------------------------------

/**
 * @param {object} obs a plain observation for one employee period.
 * @returns {Array} the period-level checks.
 */
function evaluatePeriodChecks(obs = {}) {
  const {
    canonicalMonth = null,
    derived = null,
    eventsAvailable = true,
    targetHasEvents = false,
    targetHasRows = false,
    eventsEmployeeCount = 0,
    rowEmployeeCount = 0,
    missingWorkingDays = null,
    unjudgedDays = 0,
    reportTotals = null,
  } = obs;
  const checks = [];

  // 1. employee_count: distinct employees with source events vs with canonical rows. For a per-employee
  // reconciliation the only factual disagreement is when the TARGET employee is present in one population
  // but not the other; the raw counts are reported for context but never make other employees a mismatch.
  if (eventsAvailable !== true) {
    checks.push(makeCheck('employee_count', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else if (targetHasEvents !== targetHasRows) {
    checks.push(makeCheck('employee_count', 'mismatched', {
      observed: { withEvents: eventsEmployeeCount, withRows: rowEmployeeCount },
      expected: 'target_in_both_populations',
      detail: 'employee_presence_differs',
    }));
  } else {
    checks.push(makeCheck('employee_count', 'matched', {
      observed: { withEvents: eventsEmployeeCount, withRows: rowEmployeeCount },
      expected: 'target_in_both_populations',
      detail: 'employee_presence_agrees',
    }));
  }

  // 2. daily_row_coverage: working days the approved calendar expects vs canonical rows present.
  if (derived == null || derived.expectedWorkingDays == null) {
    checks.push(makeCheck('daily_row_coverage', 'incomplete', {
      observed: null, expected: 'derived_calendar', detail: 'calendar_not_derived',
    }));
  } else if (Array.isArray(missingWorkingDays) && missingWorkingDays.length > 0) {
    checks.push(makeCheck('daily_row_coverage', 'incomplete', {
      observed: missingWorkingDays.length,
      expected: 0,
      detail: 'missing_working_day_rows',
    }));
  } else {
    checks.push(makeCheck('daily_row_coverage', 'matched', {
      observed: 0, expected: 0, detail: 'working_days_covered',
    }));
  }

  // 3. month_totals: stored totals vs the figure re-derived from the canonical daily rows.
  if (canonicalMonth == null) {
    checks.push(makeCheck('month_totals', 'incomplete', {
      observed: null, expected: 'stored_month', detail: 'month_never_derived',
    }));
  } else if (derived == null) {
    checks.push(makeCheck('month_totals', 'incomplete', {
      observed: null, expected: 'derived_totals', detail: 'calendar_not_derived',
    }));
  } else {
    const differing = differingFields(canonicalMonth, derived, MONTH_TOTAL_FIELDS);
    checks.push(makeCheck('month_totals', differing.length === 0 ? 'matched' : 'mismatched', {
      observed: null, expected: null,
      detail: differing.length === 0 ? 'month_totals_agree' : `month_totals_differ:${differing.join(',')}`,
    }));
  }

  // 4. expected_working_days: stored figure vs the derived figure. NULL stays NULL (never a silent 0).
  const storedExpected = canonicalMonth?.expectedWorkingDays ?? null;
  const derivedExpected = derived?.expectedWorkingDays ?? null;
  if (canonicalMonth == null) {
    checks.push(makeCheck('expected_working_days', 'incomplete', {
      observed: null, expected: 'stored_month', detail: 'month_never_derived',
    }));
  } else if (derivedExpected == null && storedExpected == null) {
    checks.push(makeCheck('expected_working_days', 'matched', {
      observed: null, expected: null, detail: 'expected_working_days_null_agreed',
    }));
  } else if (derivedExpected == null) {
    checks.push(makeCheck('expected_working_days', 'mismatched', {
      observed: storedExpected, expected: null, detail: 'expected_working_days_not_derivable',
    }));
  } else if (storedExpected == null) {
    checks.push(makeCheck('expected_working_days', 'mismatched', {
      observed: null, expected: derivedExpected, detail: 'expected_working_days_stored_null',
    }));
  } else {
    checks.push(makeCheck('expected_working_days', numericEqual(storedExpected, derivedExpected) ? 'matched' : 'mismatched', {
      observed: storedExpected, expected: derivedExpected,
      detail: numericEqual(storedExpected, derivedExpected) ? 'expected_working_days_agree' : 'expected_working_days_differ',
    }));
  }

  // 5. report_totals_agreement: the R-02 report totals vs the stored month row.
  if (canonicalMonth == null) {
    checks.push(makeCheck('report_totals_agreement', 'incomplete', {
      observed: null, expected: 'stored_month', detail: 'month_never_derived',
    }));
  } else if (reportTotals == null) {
    checks.push(makeCheck('report_totals_agreement', 'incomplete', {
      observed: null, expected: 'report_totals', detail: 'report_totals_unavailable',
    }));
  } else {
    const differing = differingFields(canonicalMonth, reportTotals, REPORT_TOTAL_FIELDS);
    checks.push(makeCheck('report_totals_agreement', differing.length === 0 ? 'matched' : 'mismatched', {
      observed: null, expected: null,
      detail: differing.length === 0 ? 'report_totals_agree' : `report_totals_differ:${differing.join(',')}`,
    }));
  }

  // 6. unjudged_days: a derived month that contains a day nobody could judge is not a full judgement.
  if (canonicalMonth == null) {
    checks.push(makeCheck('unjudged_days', 'incomplete', {
      observed: null, expected: 0, detail: 'month_never_derived',
    }));
  } else if (Number(unjudgedDays) > 0) {
    checks.push(makeCheck('unjudged_days', 'incomplete', {
      observed: Number(unjudgedDays), expected: 0, detail: 'unjudged_days_present',
    }));
  } else {
    checks.push(makeCheck('unjudged_days', 'matched', {
      observed: 0, expected: 0, detail: 'no_unjudged_days',
    }));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// fiscal-year checks (aggregated over the months of the fiscal period)
// ---------------------------------------------------------------------------

/**
 * @param {object} obs a plain observation for one employee fiscal year.
 * @param {Array}  obs.months one entry per fiscal month:
 *   `{ key, started, hasCanonicalMonth, unjudgedDays, missingWorkingDays, storedTotals, derivedTotals,
 *      reportTotals, storedExpected, derivedExpected }`
 * @returns {Array} the fiscal checks.
 */
function evaluateFiscalChecks(obs = {}) {
  const {
    eventsAvailable = true,
    targetHasEvents = false,
    targetHasRows = false,
    eventsEmployeeCount = 0,
    rowEmployeeCount = 0,
    months = [],
  } = obs;
  const startedMonths = (Array.isArray(months) ? months : []).filter((entry) => entry.started === true);
  const checks = [];

  // 1. employee_count (whole fiscal range).
  if (eventsAvailable !== true) {
    checks.push(makeCheck('employee_count', 'blocked', {
      observed: null, expected: null, detail: 'events_source_unavailable',
    }));
  } else if (targetHasEvents !== targetHasRows) {
    checks.push(makeCheck('employee_count', 'mismatched', {
      observed: { withEvents: eventsEmployeeCount, withRows: rowEmployeeCount },
      expected: 'target_in_both_populations',
      detail: 'employee_presence_differs',
    }));
  } else {
    checks.push(makeCheck('employee_count', 'matched', {
      observed: { withEvents: eventsEmployeeCount, withRows: rowEmployeeCount },
      expected: 'target_in_both_populations',
      detail: 'employee_presence_agrees',
    }));
  }

  // 2. fiscal_month_coverage: every STARTED month of the period must have a stored canonical month.
  const underivedKeys = startedMonths.filter((entry) => entry.hasCanonicalMonth !== true).map((entry) => entry.key);
  checks.push(makeCheck('fiscal_month_coverage', underivedKeys.length === 0 ? 'matched' : 'incomplete', {
    observed: underivedKeys,
    expected: 'every_started_month_derived',
    detail: underivedKeys.length === 0 ? 'fiscal_months_covered' : 'fiscal_months_never_derived',
  }));

  // 3. month_totals: sum of stored totals vs sum of the totals re-derived from the canonical rows.
  const withBoth = startedMonths.filter((entry) => entry.storedTotals != null && entry.derivedTotals != null);
  if (startedMonths.length === 0) {
    checks.push(makeCheck('month_totals', 'incomplete', {
      observed: null, expected: 'started_month', detail: 'no_started_months',
    }));
  } else if (withBoth.length !== startedMonths.length) {
    checks.push(makeCheck('month_totals', 'incomplete', {
      observed: withBoth.length, expected: startedMonths.length, detail: 'fiscal_month_never_derived',
    }));
  } else {
    const sum = (field) => withBoth.reduce((total, entry) => total + (Number(entry.storedTotals[field]) || 0), 0);
    const sumDerived = (field) => withBoth.reduce((total, entry) => total + (Number(entry.derivedTotals[field]) || 0), 0);
    const differing = MONTH_TOTAL_FIELDS.filter((field) => !numericEqual(sum(field), sumDerived(field)));
    checks.push(makeCheck('month_totals', differing.length === 0 ? 'matched' : 'mismatched', {
      observed: null, expected: null,
      detail: differing.length === 0 ? 'fiscal_month_totals_agree' : `fiscal_month_totals_differ:${differing.join(',')}`,
    }));
  }

  // 4. expected_working_days: a NULL stays NULL. Only months that WERE derived contribute, mirroring the
  // R-02 academic rollup; a month never derived is reported by `fiscal_month_coverage`, not as a zero here.
  const derivedMonths = startedMonths.filter((entry) => entry.storedTotals != null);
  if (startedMonths.length === 0 || derivedMonths.length === 0) {
    checks.push(makeCheck('expected_working_days', 'incomplete', {
      observed: null, expected: null, detail: 'fiscal_month_never_derived',
    }));
  } else {
    const storedValues = derivedMonths.map((entry) => entry.storedExpected ?? null);
    const derivedValues = derivedMonths.map((entry) => entry.derivedExpected ?? null);
    const allStoredNull = storedValues.every((value) => value == null);
    const allDerivedNull = derivedValues.every((value) => value == null);
    if (allStoredNull && allDerivedNull) {
      checks.push(makeCheck('expected_working_days', 'matched', {
        observed: null, expected: null, detail: 'expected_working_days_null_agreed',
      }));
    } else if (!allDerivedNull && !allStoredNull) {
      const storedSum = storedValues.reduce((total, value) => total + Number(value || 0), 0);
      const derivedSum = derivedValues.reduce((total, value) => total + Number(value || 0), 0);
      checks.push(makeCheck('expected_working_days', numericEqual(storedSum, derivedSum) ? 'matched' : 'mismatched', {
        observed: storedSum, expected: derivedSum,
        detail: numericEqual(storedSum, derivedSum) ? 'expected_working_days_agree' : 'expected_working_days_differ',
      }));
    } else {
      checks.push(makeCheck('expected_working_days', 'mismatched', {
        observed: null, expected: null, detail: 'expected_working_days_null_mismatch',
      }));
    }
  }

  // 5. report_totals_agreement: aggregate the R-02 totals against the stored months.
  const withReport = startedMonths.filter((entry) => entry.storedTotals != null && entry.reportTotals != null);
  if (startedMonths.length === 0) {
    checks.push(makeCheck('report_totals_agreement', 'incomplete', {
      observed: null, expected: null, detail: 'no_started_months',
    }));
  } else if (withReport.length !== startedMonths.length) {
    checks.push(makeCheck('report_totals_agreement', 'incomplete', {
      observed: withReport.length, expected: startedMonths.length, detail: 'fiscal_report_totals_unavailable',
    }));
  } else {
    const differing = REPORT_TOTAL_FIELDS.filter((field) => {
      const storedSum = withReport.reduce((total, entry) => total + (Number(entry.storedTotals[field]) || 0), 0);
      const reportSum = withReport.reduce((total, entry) => total + (Number(entry.reportTotals[field]) || 0), 0);
      return !numericEqual(storedSum, reportSum);
    });
    checks.push(makeCheck('report_totals_agreement', differing.length === 0 ? 'matched' : 'mismatched', {
      observed: null, expected: null,
      detail: differing.length === 0 ? 'fiscal_report_totals_agree' : `fiscal_report_totals_differ:${differing.join(',')}`,
    }));
  }

  // 6. unjudged_days: any started month with a day nobody could judge is not a full judgement.
  const unjudgedTotal = startedMonths.reduce((total, entry) => total + (Number(entry.unjudgedDays) || 0), 0);
  const missingTotal = startedMonths.reduce(
    (total, entry) => total + (Array.isArray(entry.missingWorkingDays) ? entry.missingWorkingDays.length : 0),
    0,
  );
  if (startedMonths.length === 0) {
    checks.push(makeCheck('unjudged_days', 'incomplete', {
      observed: null, expected: 0, detail: 'no_started_months',
    }));
  } else if (unjudgedTotal > 0 || missingTotal > 0) {
    checks.push(makeCheck('unjudged_days', 'incomplete', {
      observed: { unjudgedDays: unjudgedTotal, missingWorkingDays: missingTotal }, expected: 0,
      detail: 'unjudged_days_present',
    }));
  } else {
    checks.push(makeCheck('unjudged_days', 'matched', {
      observed: 0, expected: 0, detail: 'no_unjudged_days',
    }));
  }

  return checks;
}

module.exports = {
  CHECK_STATUS,
  STATUS_SEVERITY,
  KNOWN_COMPUTATION_STATUSES,
  UNJUDGED_COMPUTATION_STATUSES,
  MONTH_TOTAL_FIELDS,
  REPORT_TOTAL_FIELDS,
  REAL_SOURCE_NOTE,
  makeCheck,
  verdictOf,
  countCheckStatuses,
  unresolvedChecks,
  statusReasonsOf,
  differingFields,
  evaluateDayChecks,
  evaluatePeriodChecks,
  evaluateFiscalChecks,
};
