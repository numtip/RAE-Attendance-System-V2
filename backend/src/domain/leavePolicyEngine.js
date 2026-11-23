/**
 * Leave entitlement engine — PHASE 1: pure, versioned, UNWIRED.
 *
 * No service, route, repository or migration imports this file. It takes plain facts in and returns plain
 * results out; it never reads a database and never guesses. Wiring it into leaveService is a later, separately
 * approved step (docs/policies/MJU_LEAVE_POLICY_2569.md §4).
 *
 * HOW A RESULT IS REPORTED
 * ------------------------
 * Every leave type returns a `status`:
 *   ok                  the numbers are determined.
 *   unknown             a fact the rule needs is missing (hire date, continuity, appointment kind, carry-over).
 *                       The missing facts are listed in `missing`; no number is invented, never a "0".
 *   pending_policy      the date/year is not fully under a policy on file (before 2026-08-21, or a fiscal year
 *                       the policy starts inside). The 2023-11-16 announcement is not on file, so FY2569 is
 *                       NOT recomputed under the new one.
 *   pending_hr_decision the announcement does not say how to treat the case (mid-year first-year, 6 months or
 *                       10 years reached mid-year). `candidates` shows each reading; none is chosen.
 *   needs_hr            the personnel type is not defined by the announcement; HR must confirm. NOT "ineligible".
 *   out_of_scope        outsourced staff (จ้างเหมา), not พนักงานมหาวิทยาลัย under clause 4.
 *   not_started         the known hire date is after the fiscal year ends.
 *
 * Paid-leave ALLOWANCE vs absolute LIMIT: sick (60) and personal (45) are days paid during leave
 * (kind `paid_leave_allowance`), not a ceiling on leave that may be taken. Using more is reported as
 * `overAllowanceDays`, never as absence. Vacation is a `leave_right` with its own cap. `absoluteLimitDays`
 * is null because the announcement sets no absolute limit for these three.
 *
 * Only APPROVED leave of an ELIGIBLE employee under a policy in force is deducted. Recorded, awaiting,
 * needs-review and rejected days are never deducted. A clause-14 exception removes days from the deduction
 * only with evidence of who authorised it and the reference.
 *
 * Dates are `YYYY-MM-DD` strings (Asia/Bangkok calendar days); no Date/timezone arithmetic.
 */

const { POLICIES } = require('./leavePolicy2569');
const { ALL_POLICIES, familyForType } = require('./leavePolicySection');

const TYPES = Object.freeze(['sick', 'personal', 'vacation']);
const STATUS = Object.freeze({
  OK: 'ok',
  UNKNOWN: 'unknown',
  PENDING_POLICY: 'pending_policy',
  PENDING_HR_DECISION: 'pending_hr_decision',
  NEEDS_HR: 'needs_hr',
  OUT_OF_SCOPE: 'out_of_scope',
  NOT_STARTED: 'not_started',
});

// ---------------------------------------------------------------- dates

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value, name = 'date') {
  const m = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!m) throw new TypeError(`${name} must be a YYYY-MM-DD string`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new TypeError(`${name} is not a real calendar date: ${value}`);
  }
  return { y, m: mo, d };
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Calendar-month addition; the day is clamped to the target month (31 Aug + 6 months = 28/29 Feb). */
function addMonths(value, months) {
  const { y, m, d } = parseDate(value);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

function addDays(value, days) {
  const { y, m, d } = parseDate(value);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
function isoWeekday(value) {
  const { y, m, d } = parseDate(value);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Fiscal year (1 Oct – 30 Sep) named by the Buddhist-era year in which it ends: 2026-10-01 -> FY2570. */
function fiscalYearByBE(be) {
  if (!Number.isInteger(be) || be < 2500 || be > 2700) throw new TypeError('fiscal year must be a Buddhist-era year (e.g. 2569)');
  const ce = be - 543;
  return { be, ce, start: `${ce - 1}-10-01`, end: `${ce}-09-30` };
}

function fiscalYearOf(date) {
  const { y, m } = parseDate(date);
  return fiscalYearByBE((m >= 10 ? y + 1 : y) + 543);
}

// ---------------------------------------------------------------- policy

/** The policy in force on a date, or null when the date predates every policy on file. */
function policyForDate(date, policies = POLICIES) {
  parseDate(date);
  let found = null;
  for (const policy of policies) {
    if (policy.effectiveFrom <= date && (!found || policy.effectiveFrom > found.effectiveFrom)) found = policy;
  }
  return found;
}

/**
 * Policy to use for a whole fiscal year. A year that starts before the first policy, or that a policy starts
 * inside, is a transition year: the earlier rules are not on file, so it stays pending_policy.
 */
function policyForFiscalYear(fy, policies = POLICIES) {
  const atStart = policyForDate(fy.start, policies);
  if (!atStart) {
    const inside = policies.find((p) => p.effectiveFrom > fy.start && p.effectiveFrom <= fy.end);
    return { policy: null, reason: inside ? 'policy_effective_mid_year' : 'no_policy_for_period', effectiveFrom: inside ? inside.effectiveFrom : null };
  }
  const startsInside = policies.find((p) => p.effectiveFrom > fy.start && p.effectiveFrom <= fy.end);
  if (startsInside) return { policy: null, reason: 'policy_effective_mid_year', effectiveFrom: startsInside.effectiveFrom };
  return { policy: atStart, reason: null, effectiveFrom: atStart.effectiveFrom };
}

// ---------------------------------------------------------------- eligibility

/**
 * Scope of the announcement for one employee. `employee.eligibilityConfirmation = { confirmed, reference }`
 * records an HR decision for the person; without a reference it is ignored (and flagged).
 */
function classifyEligibility(employee, policy, { unmapped = false } = {}) {
  const flags = [];
  const confirmation = employee?.eligibilityConfirmation;
  // A type with no mapped policy (unknown only) is never settled by a confirmation: that cannot choose a policy.
  if (!unmapped && confirmation && typeof confirmation.confirmed === 'boolean') {
    if (confirmation.reference && String(confirmation.reference).trim()) {
      return { status: confirmation.confirmed ? 'eligible' : 'out_of_scope', source: 'hr_confirmation', flags };
    }
    flags.push({ code: 'eligibility_confirmation_missing_reference' });
  }
  const mapped = unmapped ? null : policy.employeeTypes[employee?.employeeType];
  if (!mapped) return { status: 'needs_hr', source: 'employee_type', reason: 'employee_type_unmapped', flags };
  return { status: mapped, source: 'employee_type', reason: mapped === 'eligible' ? null : `employee_type_${mapped}`, flags };
}

/**
 * The policy that applies to an employment type for a fiscal year: its family, the policy in force (or why none is),
 * and `anyPolicy` — the family's latest policy, used to classify a person even in a year no policy covers yet.
 * An unmapped type (unknown only; procurement_academic is mapped to the university family) has no family: it is
 * classified against the university table as `needs_hr` and stays there.
 */
function policyContextFor(employeeType, fy, policies = ALL_POLICIES) {
  const family = familyForType(employeeType);
  const pool = policies.filter((p) => (p.family || 'university') === (family || 'university'));
  const anyPolicy = pool.reduce((latest, p) => (!latest || (p.effectiveFrom || '') > (latest.effectiveFrom || '') ? p : latest), null);
  return { family, unmapped: family === null, anyPolicy, ...policyForFiscalYear(fy, pool) };
}

// ---------------------------------------------------------------- usage

function dayKey(row) { return `${row.leaveType}|${row.date}`; }

/**
 * Approved, deductible days of ONE leave type inside the fiscal year, each calendar day once.
 * `countFrom` (default: the policy's effective date) is the first day that is counted at all; a caller that holds
 * a verified entitlement for an earlier year passes the fiscal-year start so those days are counted too, while
 * the announcement's own review rules (half-day vacation, ...) still apply only from its effective date.
 * Returns the deductible total, the approved total before exceptions, and review flags.
 */
function summarizeUsage(records, fy, policy, leaveType, { countFrom = policy.effectiveFrom || fy.start } = {}) {
  const flags = [];
  const byDay = new Map();
  for (const row of records || []) {
    if (!row || row.leaveType !== leaveType || typeof row.date !== 'string') continue;
    if (row.date < fy.start || row.date > fy.end) continue;
    if (row.status !== 'approved') continue; // recorded / awaiting / needs_review / rejected never deduct
    if (row.date < countFrom) { flags.push({ code: 'before_policy_effective', date: row.date }); continue; }
    const fraction = row.dayFraction;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      flags.push({ code: 'invalid_fraction', date: row.date });
      continue;
    }
    if (!byDay.has(dayKey(row))) byDay.set(dayKey(row), { date: row.date, parts: new Map() });
    const part = row.dayPart || 'FULL';
    const day = byDay.get(dayKey(row));
    if (day.parts.has(part)) { flags.push({ code: 'duplicate_day_part', date: row.date }); continue; }
    day.parts.set(part, { fraction, exception: row.nonDeductible || null });
  }

  let approved = 0;
  let nonDeductible = 0;
  for (const { date, parts } of byDay.values()) {
    const entries = [...parts.entries()];
    const full = parts.get('FULL');
    const counted = full ? [['FULL', full]] : entries;
    if (full && entries.length > 1) flags.push({ code: 'overlapping_day_parts', date });
    let dayTotal = 0;
    let dayExempt = 0;
    for (const [, { fraction, exception }] of counted) {
      dayTotal += fraction;
      if (exception) {
        const rule = policy.nonDeductibleException;
        const valid = Boolean(rule) && exception.clause === rule.clause
          && rule.requiredEvidence.every((k) => exception[k] && String(exception[k]).trim());
        if (valid) dayExempt += fraction;
        else flags.push({ code: 'clause14_unauthorized', date, detail: 'exception needs authorizedBy and reference; the day is deducted' });
      }
    }
    if (dayTotal > 1) { flags.push({ code: 'day_over_one', date }); dayTotal = 1; dayExempt = Math.min(dayExempt, 1); }
    approved += dayTotal;
    nonDeductible += dayExempt;

    // Rules of the announcement are not applied to days before it took effect, even when those days are counted.
    const underPolicy = policy.effectiveFrom ? date >= policy.effectiveFrom : true;
    if (underPolicy && leaveType === 'vacation' && policy.vacation.minDaysPerRequest && dayTotal < policy.vacation.minDaysPerRequest) {
      flags.push({ code: 'vacation_half_day_review', date, detail: `the policy sets a ${policy.vacation.minDaysPerRequest} working day minimum; kept as recorded, not rounded` });
    }
    if (underPolicy && leaveType === 'personal' && policy.personal.minDaysPerRequest && dayTotal < policy.personal.minDaysPerRequest) {
      flags.push({ code: 'personal_below_minimum', date });
    }
  }
  if (leaveType === 'sick' && policy.sick.medicalCertificate) flags.push(...medicalCertificateFlags(byDay, policy.sick.medicalCertificate));
  return { approvedRecordedDays: approved, nonDeductibleDays: nonDeductible, usedDays: approved - nonDeductible, flags };
}

/**
 * Review flag for sick leave that reaches the policy's medical-certificate threshold in ONE continuous leave:
 * `gte` (section employees: 3 working days or more) or `gt` (section contract staff: more than 3). Continuous means
 * consecutive working days; a weekend does not break it (no holiday calendar exists, so a holiday does and the flag
 * may then be missed). It never approves, rejects or deducts anything: it asks a person to look at the document.
 */
function medicalCertificateFlags(byDay, rule) {
  const days = [...byDay.values()]
    .map(({ date, parts }) => {
      const full = parts.get('FULL');
      const total = full ? full.fraction : [...parts.values()].reduce((n, p) => n + p.fraction, 0);
      return { date, total: Math.min(1, total) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const continues = (a, b) => {
    if (addDays(a, 1) === b) return true;
    const weekday = isoWeekday(a);
    return (weekday === 5 && addDays(a, 3) === b) || (weekday === 6 && addDays(a, 2) === b); // Fri -> Mon, Sat -> Mon
  };
  const flags = [];
  let run = [];
  const close = () => {
    if (!run.length) return;
    const total = run.reduce((n, d) => n + d.total, 0);
    if (rule.comparison === 'gte' ? total >= rule.fromWorkingDays : total > rule.fromWorkingDays) {
      flags.push({ code: 'medical_certificate_review', date: run[0].date, detail: `${total} working days in one continuous sick leave; threshold ${rule.comparison === 'gte' ? 'at least' : 'more than'} ${rule.fromWorkingDays}` });
    }
    run = [];
  };
  for (const day of days) {
    if (run.length && !continues(run[run.length - 1].date, day.date)) close();
    run.push(day);
  }
  close();
  return flags;
}

// ---------------------------------------------------------------- per-type entitlement

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);

function base(leaveType, kind) {
  return {
    leaveType,
    kind,
    status: STATUS.OK,
    reasons: [],
    missing: [],
    candidates: null,
    entitlementDays: null,
    carryoverDays: null,
    availableDays: null,
    usedDays: null,
    remainingDays: null,
    overAllowanceDays: null,
    nonDeductibleDays: null,
    approvedRecordedDays: null,
    absoluteLimitDays: null,
    flags: [],
  };
}

function notStarted(out, hireDate, fy) {
  out.status = STATUS.NOT_STARTED;
  out.reasons.push('hire_date_after_fiscal_year_end');
  out.detail = { hireDate, fiscalYearEnd: fy.end };
  return out;
}

function sickEntitlement(ctx) {
  const { policy, employee, fy, grants } = ctx;
  const out = base('sick', policy.sick.kind);
  if (isDate(employee.hireDate) && employee.hireDate > fy.end) return notStarted(out, employee.hireDate, fy);
  const extra = grants?.sickExtensionDays ?? 0;
  if (typeof extra !== 'number' || extra < 0 || extra > policy.sick.discretionaryExtraPaidDaysMax) {
    throw new RangeError(`sickExtensionDays must be between 0 and ${policy.sick.discretionaryExtraPaidDaysMax} (rector decision, clause 18)`);
  }
  out.entitlementDays = policy.sick.paidDaysPerFiscalYear;
  out.availableDays = policy.sick.paidDaysPerFiscalYear + extra;
  out.extensionGrantedDays = extra; // 0 = none granted; the extra 60 is never automatic
  return out;
}

function personalEntitlement(ctx) {
  const { policy, employee, fy } = ctx;
  const out = base('personal', policy.personal.kind);
  if (!isDate(employee.hireDate)) { out.status = STATUS.UNKNOWN; out.missing.push('hireDate'); return out; }
  if (employee.hireDate > fy.end) return notStarted(out, employee.hireDate, fy);
  const normal = policy.personal.paidDaysPerFiscalYear;
  const first = policy.personal.firstEmploymentYearPaidDays;

  // The "first year" can only apply while less than 12 months of service precede the year's end boundary.
  // Service counts from the earliest known start; clause 62 continuity can only make it longer.
  const hasContinuity = isDate(employee.continuousServiceStart);
  const start = hasContinuity && employee.continuousServiceStart < employee.hireDate ? employee.continuousServiceStart : employee.hireDate;
  const inFirstYearZone = (s) => addMonths(s, 12) > fy.start;

  if (!inFirstYearZone(employee.hireDate)) { out.entitlementDays = normal; out.availableDays = normal; return out; }
  if (!hasContinuity) { out.status = STATUS.UNKNOWN; out.missing.push('continuousServiceStart'); out.reasons.push('continuity_could_end_first_year'); return out; }
  if (!inFirstYearZone(start)) { out.entitlementDays = normal; out.availableDays = normal; return out; }

  // First year of employment: unambiguous only when service starts on 1 October.
  const onFiscalStart = start.slice(5) === '10-01';
  if (onFiscalStart && start >= fy.start) { out.entitlementDays = first; out.availableDays = first; out.reasons.push('first_employment_year'); return out; }
  out.status = STATUS.PENDING_HR_DECISION;
  out.reasons.push('first_year_interpretation_pending_hr');
  out.candidates = start >= fy.start
    ? [{ reading: 'first_year_by_fiscal_year_or_12_months', entitlementDays: first }]
    : [{ reading: 'first_year_is_the_fiscal_year_of_appointment', entitlementDays: normal },
      { reading: 'first_year_is_the_first_12_months', entitlementDays: first }];
  return out;
}

/** 'yes' | 'no' | 'mid_year' | 'unknown' for "10 years continuous service" within a fiscal year. */
function tenYearStatus(policy, employee, fy) {
  if (!isDate(employee.continuousServiceStart)) return 'unknown';
  const tenth = addMonths(employee.continuousServiceStart, policy.vacation.continuousServiceYearsForHigherCap * 12);
  if (tenth <= fy.start) return 'yes';
  if (tenth > fy.end) return 'no';
  return 'mid_year';
}

function vacationEntitlement(ctx) {
  const { policy, employee, fy, carryover } = ctx;
  const v = policy.vacation;
  const out = base('vacation', v.kind);
  if (!isDate(employee.hireDate)) { out.status = STATUS.UNKNOWN; out.missing.push('hireDate'); return out; }
  if (employee.hireDate > fy.end) return notStarted(out, employee.hireDate, fy);

  // 1. Current-year right (clause 23).
  let current = v.daysPerFiscalYear;
  const hiredThisYear = employee.hireDate >= fy.start;
  if (hiredThisYear && employee.hireDate > fy.start) {
    if (!employee.appointmentKind) { out.status = STATUS.UNKNOWN; out.missing.push('appointmentKind'); return out; }
    const excluded = v.noRightAppointmentKinds.includes(employee.appointmentKind);
    const sixMonthsOn = addMonths(employee.hireDate, v.noRightFirstMonths);
    if (excluded && sixMonthsOn > fy.end) {
      current = 0; // a determined "no right" (clause 23), not a missing value
      out.reasons.push('clause_23_under_six_months');
    } else {
      out.status = STATUS.PENDING_HR_DECISION;
      out.reasons.push(excluded ? 'six_months_reached_mid_year_pending_hr' : 'partial_year_allocation_pending_hr');
      out.candidates = excluded
        ? [{ reading: 'right_from_the_year_start', entitlementDays: v.daysPerFiscalYear }, { reading: 'right_from_the_six_month_date', entitlementDays: null }]
        : [{ reading: 'full_annual_right', entitlementDays: v.daysPerFiscalYear }];
      out.entitlementDays = null;
      return out;
    }
  } else if (hiredThisYear && employee.hireDate === fy.start) {
    if (!employee.appointmentKind) { out.status = STATUS.UNKNOWN; out.missing.push('appointmentKind'); return out; }
    if (v.noRightAppointmentKinds.includes(employee.appointmentKind)) {
      out.status = STATUS.PENDING_HR_DECISION;
      out.reasons.push('six_months_reached_mid_year_pending_hr');
      out.candidates = [{ reading: 'right_from_the_year_start', entitlementDays: v.daysPerFiscalYear }, { reading: 'right_from_the_six_month_date', entitlementDays: null }];
      return out;
    }
  }
  out.entitlementDays = current;

  // 2. Carry-over (clause 24): certified by HR; never assumed to be 0.
  let carry = carryover;
  const noEarlierService = (isDate(employee.continuousServiceStart) && employee.continuousServiceStart >= fy.start)
    || (hiredThisYear && employee.appointmentKind === 'first');
  if ((carry === undefined || carry === null) && noEarlierService) {
    carry = 0; // service began inside this year: there is no earlier year to carry from
    out.reasons.push('no_earlier_service_to_carry');
  }
  if (typeof carry !== 'number' || !Number.isFinite(carry) || carry < 0) {
    out.status = STATUS.UNKNOWN;
    out.missing.push('vacationCarryoverDays');
    out.carryoverDays = null;
    return out;
  }
  out.carryoverDays = carry;

  // 3. Cap: carry-over + this year's days <= 20, or 30 after 10 years' continuous service.
  let usableCarry = carry;
  if (carry + current > v.combinedCapDays) {
    const ten = tenYearStatus(policy, employee, fy);
    if (ten === 'unknown') { out.status = STATUS.UNKNOWN; out.missing.push('continuousServiceStart'); out.reasons.push('cap_depends_on_ten_years_continuous_service'); return out; }
    if (ten === 'mid_year') {
      out.status = STATUS.PENDING_HR_DECISION;
      out.reasons.push('ten_years_reached_mid_year_pending_hr');
      out.candidates = [v.combinedCapDays, v.combinedCapDaysAfter10YearsContinuous].map((cap) => ({
        reading: `cap_${cap}`,
        entitlementDays: current,
        carryoverDays: Math.min(carry, Math.max(0, cap - current)),
        availableDays: current + Math.min(carry, Math.max(0, cap - current)),
      }));
      return out;
    }
    const cap = ten === 'yes' ? v.combinedCapDaysAfter10YearsContinuous : v.combinedCapDays;
    usableCarry = Math.min(carry, Math.max(0, cap - current));
    if (usableCarry < carry) out.reasons.push(`carryover_capped_at_${cap}`);
    out.capDays = cap;
  } else {
    out.capDays = null; // the cap cannot bind, so the 10-year question does not matter
  }
  out.usableCarryoverDays = usableCarry;
  out.availableDays = current + usableCarry;
  return out;
}

// ---------------------------------------------------------------- section policies

/** Personal / vacation right that depends on months of service (section employees only). */
function serviceGatedEntitlement(ctx, leaveType) {
  const { policy, employee, fy } = ctx;
  const rule = policy[leaveType];
  const days = leaveType === 'personal' ? rule.paidDaysPerFiscalYear : rule.daysPerFiscalYear;
  const out = base(leaveType, rule.kind);
  if (!isDate(employee.hireDate)) { out.status = STATUS.UNKNOWN; out.missing.push('hireDate'); return out; }
  if (employee.hireDate > fy.end) return notStarted(out, employee.hireDate, fy);
  const qualifiesOn = addMonths(employee.hireDate, rule.minServiceMonths);
  if (qualifiesOn <= fy.start) { out.entitlementDays = days; out.availableDays = days; return out; }
  if (qualifiesOn > fy.end) {
    // Service stays under the minimum for the whole year: a determined "no right", not a missing value.
    out.entitlementDays = 0; out.availableDays = 0;
    out.reasons.push(`service_under_${rule.minServiceMonths}_months`);
    return out;
  }
  // The minimum is reached inside the year. The announcement does not say how to allocate it: no prorating here.
  out.status = STATUS.PENDING_HR_DECISION;
  out.reasons.push('qualification_mid_year_pending_owner_decision');
  out.candidates = [{ reading: 'full_annual_right', entitlementDays: days }, { reading: 'right_from_the_qualification_date', entitlementDays: null }];
  out.detail = { qualifiesOn };
  return out;
}

const sectionBuilders = {
  section_employee: {
    sick: (ctx) => {
      const out = base('sick', ctx.policy.sick.kind);
      if (isDate(ctx.employee.hireDate) && ctx.employee.hireDate > ctx.fy.end) return notStarted(out, ctx.employee.hireDate, ctx.fy);
      out.entitlementDays = ctx.policy.sick.paidDaysPerFiscalYear; // no hire date needed for the ceiling
      out.availableDays = out.entitlementDays;
      return out;
    },
    personal: (ctx) => serviceGatedEntitlement(ctx, 'personal'),
    vacation: (ctx) => withNoCarryover(serviceGatedEntitlement(ctx, 'vacation'), ctx),
  },
  section_contract: {
    sick: (ctx) => fixedEntitlement(ctx, 'sick', ctx.policy.sick.paidDaysPerFiscalYear),
    personal: (ctx) => fixedEntitlement(ctx, 'personal', ctx.policy.personal.paidDaysPerFiscalYear),
    vacation: (ctx) => withNoCarryover(fixedEntitlement(ctx, 'vacation', ctx.policy.vacation.daysPerFiscalYear), ctx),
  },
};

/** The figure of the policy as is: no tenure condition and no hire date needed (a known one after the year's end still means not started). */
function fixedEntitlement(ctx, leaveType, days) {
  const out = base(leaveType, ctx.policy[leaveType].kind);
  if (isDate(ctx.employee.hireDate) && ctx.employee.hireDate > ctx.fy.end) return notStarted(out, ctx.employee.hireDate, ctx.fy);
  out.entitlementDays = days;
  out.availableDays = days;
  return out;
}

/** These policies have no vacation carry-over: it is 0 by rule (never asked for). A positive figure supplied is refused, not added. */
function withNoCarryover(out, ctx) {
  if (out.status === STATUS.NOT_STARTED || out.status === STATUS.UNKNOWN) return out;
  out.carryoverDays = 0;
  if (typeof ctx.carryover === 'number' && ctx.carryover > 0) {
    out.flags.push({ code: 'carryover_not_allowed', detail: `this policy has no vacation carry-over; the ${ctx.carryover} day(s) on file are not added` });
  }
  return out;
}

// ---------------------------------------------------------------- compose

function applyUsage(out, records, fy, policy) {
  const usage = summarizeUsage(records, fy, policy, out.leaveType);
  out.approvedRecordedDays = usage.approvedRecordedDays;
  out.nonDeductibleDays = usage.nonDeductibleDays;
  out.usedDays = usage.usedDays;
  out.flags.push(...usage.flags);
  const finish = (available) => ({
    remaining: Math.max(0, available - usage.usedDays),
    over: Math.max(0, usage.usedDays - available),
  });
  if (out.status === STATUS.OK && out.availableDays !== null) {
    const { remaining, over } = finish(out.availableDays);
    out.remainingDays = remaining;
    out.overAllowanceDays = over;
  }
  if (out.candidates) {
    out.candidates = out.candidates.map((c) => {
      const available = c.availableDays ?? c.entitlementDays;
      return available === null || available === undefined ? { ...c, remainingDays: null } : { ...c, remainingDays: finish(available).remaining };
    });
  }
  return out;
}

/**
 * Entitlement, approved usage and remaining balance for one employee and one fiscal year.
 *
 * @param {object} input
 * @param {number} input.fiscalYear  Buddhist-era fiscal year (2570 = 2026-10-01 .. 2027-09-30).
 * @param {object} input.employee    { employeeType, hireDate|null, continuousServiceStart|null,
 *                                     appointmentKind|null ('first'|'rehire_after_resignation'|'rehire_after_dismissal'|'other'),
 *                                     eligibilityConfirmation?: { confirmed, reference } }
 * @param {Array}  [input.records]   approved/other leave days: { date, leaveType, dayPart, dayFraction, status, nonDeductible? }
 * @param {object} [input.carryover] { vacationDays: number|null } HR-certified days carried in from the previous year.
 * @param {object} [input.grants]    { sickExtensionDays } rector-approved extra paid sick days (0..60).
 * @param {Array}  [input.policies]  override the registry (tests).
 */
function computeEntitlements({ fiscalYear, employee, records = [], carryover = {}, grants = {}, policies = ALL_POLICIES }) {
  const fy = fiscalYearByBE(fiscalYear);
  const emp = employee || {};
  for (const key of ['hireDate', 'continuousServiceStart']) {
    if (emp[key] !== null && emp[key] !== undefined) parseDate(emp[key], key);
  }
  const resolved = policyContextFor(emp.employeeType, fy, policies);
  const result = { fiscalYear: fy, policyVersion: resolved.policy ? resolved.policy.id : null, policyFamily: resolved.family, eligibility: null, results: {} };

  if (!resolved.policy) {
    for (const type of TYPES) {
      const out = base(type, null);
      out.status = STATUS.PENDING_POLICY;
      out.reasons.push(resolved.reason);
      out.detail = { policyEffectiveFrom: resolved.effectiveFrom };
      result.results[type] = out;
    }
    return result;
  }

  const policy = resolved.policy;
  result.eligibility = classifyEligibility(emp, policy, { unmapped: resolved.unmapped });
  if (result.eligibility.status !== 'eligible') {
    const status = result.eligibility.status === 'needs_hr' ? STATUS.NEEDS_HR : STATUS.OUT_OF_SCOPE;
    for (const type of TYPES) {
      const out = base(type, policy[type].kind);
      out.status = status;
      out.reasons.push(result.eligibility.reason);
      out.flags.push(...result.eligibility.flags);
      // Informational only: not deducted, because the employee is not (yet) confirmed eligible.
      out.approvedRecordedDays = summarizeUsage(records, fy, policy, type).approvedRecordedDays;
      result.results[type] = out;
    }
    return result;
  }

  const ctx = { policy, employee: emp, fy, grants, carryover: carryover.vacationDays };
  const builders = sectionBuilders[policy.family] || { sick: sickEntitlement, personal: personalEntitlement, vacation: vacationEntitlement };
  for (const type of TYPES) {
    const out = builders[type](ctx);
    out.flags.push(...result.eligibility.flags);
    result.results[type] = out.status === STATUS.NOT_STARTED ? out : applyUsage(out, records, fy, policy);
  }
  return result;
}

/**
 * Vacation days that may be offered to the next fiscal year: the unused part of this year's balance, only when
 * that balance is fully determined. The next year's cap is applied by computeEntitlements, not here.
 */
function vacationCarryoverForNextYear(vacationResult) {
  if (!vacationResult || vacationResult.leaveType !== 'vacation') throw new TypeError('expects a vacation result');
  if (vacationResult.status !== STATUS.OK) return { status: vacationResult.status, days: null, reasons: vacationResult.reasons, missing: vacationResult.missing };
  return { status: STATUS.OK, days: vacationResult.remainingDays };
}

// ---------------------------------------------------------------- working days and fiscal-year split

/**
 * Working days in [from, to]: weekdays minus the supplied holidays. Without a holiday calendar the answer is
 * `unknown`: Monday-Friday alone is not a complete working-day count (clause 4), so it is never assumed.
 */
function workingDaysBetween(from, to, { holidays = null, workdays = [1, 2, 3, 4, 5] } = {}) {
  parseDate(from, 'from');
  parseDate(to, 'to');
  if (from > to) throw new RangeError('from must not be after to');
  if (!holidays) return { status: STATUS.UNKNOWN, days: null, missing: ['holidayCalendar'] };
  const off = new Set(holidays);
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (workdays.includes(isoWeekday(d)) && !off.has(d)) days += 1;
  }
  return { status: STATUS.OK, days };
}

/**
 * One continuous leave across fiscal years is ONE request (clause 6) but its working days are accounted to
 * each fiscal year separately.
 */
function splitLeaveByFiscalYear(from, to, options = {}) {
  parseDate(from, 'from');
  parseDate(to, 'to');
  if (from > to) throw new RangeError('from must not be after to');
  const segments = [];
  let cursor = from;
  while (cursor <= to) {
    const fy = fiscalYearOf(cursor);
    const end = fy.end < to ? fy.end : to;
    segments.push({ fiscalYear: fy.be, from: cursor, to: end, ...workingDaysBetween(cursor, end, options) });
    cursor = addDays(end, 1);
  }
  return { requests: 1, segments };
}

module.exports = {
  STATUS,
  TYPES,
  parseDate,
  addMonths,
  addDays,
  fiscalYearByBE,
  fiscalYearOf,
  policyForDate,
  policyForFiscalYear,
  policyContextFor,
  classifyEligibility,
  summarizeUsage,
  tenYearStatus,
  computeEntitlements,
  vacationCarryoverForNextYear,
  workingDaysBetween,
  splitLeaveByFiscalYear,
};
