const { HttpError } = require('../utils/httpError');
const {
  STATUS, TYPES, computeEntitlements, summarizeUsage, fiscalYearByBE, policyForDate, tenYearStatus, classifyEligibility,
} = require('../domain/leavePolicyEngine');
const { POLICIES } = require('../domain/leavePolicy2569');
const { TYPE_LABEL, recordStatus } = require('./leaveLabels');

/**
 * Fiscal-year leave balance for ONE employee: HR-verified entitlement, else the policy engine, else no number.
 *
 * It is the only place that combines the engine with stored data, and it runs a fixed number of queries per
 * call (facts, profile, HR entitlements, leave records, legacy leave, coverage) whatever the leave types, so it
 * adds no per-employee or per-type request. Authorization is the caller's job (leaveService checks
 * `assertCanReadEmployee` before calling in).
 *
 * PRECEDENCE per leave type, see docs/policies/LEAVE_ENGINE_PHASE2_PLAN.md §3:
 *   1. a row HR verified (employee_leave_entitlement)  -> source `hr_verified`; wins for the entitlement numbers.
 *      If the policy engine could compute the same year and disagrees, the HR number is shown with a
 *      `hr_differs_from_policy` flag; nothing is overwritten or hidden.
 *   2. the policy engine, when its status is `ok`        -> source `computed`.
 *   3. otherwise no number: the engine's status, reasons and missing facts are returned as they are.
 *
 * USAGE has one source: approved leave records (plus approved legacy days that no record covers), each calendar
 * day once per type. `leave_balance` is never read here. An HR usage baseline (days used outside the system, up to
 * a date) counts once and the records dated on or before that date are not deducted again.
 *
 * COVERAGE: a month of the fiscal year that has already begun but was never imported has an unknown usage, not
 * zero; the balance is then withheld (`remainingDays: null`, `usageComplete: false`) instead of overstated.
 */

const DAY_MS = 86400000;
const utcMs = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };

function eachDate(startDate, endDate) {
  const dates = [];
  for (let t = utcMs(String(startDate).slice(0, 10)); t <= utcMs(String(endDate).slice(0, 10)); t += DAY_MS) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}

/** Asia/Bangkok calendar date of an instant. */
const bangkokDate = (instant) => new Date(instant.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** The twelve `YYYY-MM` months of a fiscal year, October first. */
function monthsOf(fy) {
  const [startYear] = fy.start.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const m = 10 + i;
    return m <= 12 ? `${startYear}-${String(m).padStart(2, '0')}` : `${startYear + 1}-${String(m - 12).padStart(2, '0')}`;
  });
}

const lastDayOfMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Day-rows in the engine's shape from stored records plus the legacy days no record covers (pure). */
function toEngineRecords(records, legacy) {
  const covered = new Set(records.map((r) => `${r.leaveType}|${r.leaveDate}`)); // a recorded day of any status
  const rows = records.map((r) => ({
    date: r.leaveDate, leaveType: r.leaveType, dayPart: r.dayPart, dayFraction: r.dayFraction === null ? null : Number(r.dayFraction), status: recordStatus(r),
  }));
  for (const row of legacy) {
    if (String(row.status || '').toLowerCase() !== 'approved' || (row.matchStatus && row.matchStatus !== 'matched')) continue;
    for (const date of eachDate(row.startDate, row.endDate)) {
      if (!covered.has(`${row.leaveType}|${date}`)) rows.push({ date, leaveType: row.leaveType, dayPart: 'FULL', dayFraction: 1, status: 'approved' });
    }
  }
  return rows;
}

function createLeaveEntitlementService({ repositories, now = () => new Date() }) {
  /** Approved/other day-rows in the engine's shape: leave records first, then legacy days no record covers. */
  async function engineRecords(employeeUid) {
    const records = typeof repositories.leaveRecords?.listForEmployee === 'function'
      ? await repositories.leaveRecords.listForEmployee(employeeUid) : [];
    return toEngineRecords(records, await repositories.leave.list(employeeUid));
  }

  async function coveredMonths() {
    return typeof repositories.leaveRecords?.coveredPeriods === 'function' ? new Set(await repositories.leaveRecords.coveredPeriods()) : new Set();
  }

  function uncoveredMonths(fy, covered, today, baselineThrough) {
    const thisMonth = today.slice(0, 7);
    return monthsOf(fy)
      .filter((m) => m <= thisMonth)
      .filter((m) => !covered.has(m))
      .filter((m) => !(baselineThrough && lastDayOfMonth(m) <= baselineThrough)); // the HR baseline already accounts for it
  }

  function pendingDaysOf(records, fy, type) {
    return records.filter((r) => r.leaveType === type && r.status === 'unverified' && r.date >= fy.start && r.date <= fy.end && typeof r.dayFraction === 'number')
      .reduce((sum, r) => sum + r.dayFraction, 0);
  }

  function engineEmployee(facts, profile) {
    const employee = {
      employeeType: facts.employeeType,
      hireDate: facts.hireDate || null,
      continuousServiceStart: profile?.continuousServiceStart || null,
      appointmentKind: profile?.appointmentKind || null,
    };
    if (profile && profile.eligibilityConfirmed !== null && profile.eligibilityConfirmed !== undefined) {
      employee.eligibilityConfirmation = { confirmed: profile.eligibilityConfirmed, reference: profile.eligibilityReference };
    }
    return employee;
  }

  /** Result row built from an HR-verified entitlement. */
  function fromHr({ type, hr, engineOut, fy, profile, records, covered, today, eligibility }) {
    const policy = policyForDate(fy.end) || POLICIES[0];
    const flags = [];
    const reasons = [];
    const missing = [];
    let status = STATUS.OK;

    // Records dated on or before the HR baseline are already inside it: they are not deducted a second time.
    let counted = records;
    let baselineDays = 0;
    if (hr.usageBaselineThrough) {
      baselineDays = hr.usageBaselineDays;
      const ignored = records.filter((r) => r.leaveType === type && r.status === 'approved' && r.date >= fy.start && r.date <= hr.usageBaselineThrough);
      counted = records.filter((r) => !(r.leaveType === type && r.date <= hr.usageBaselineThrough));
      if (ignored.length) flags.push({ code: 'records_before_baseline_ignored', detail: `${ignored.length} approved record(s) dated on or before ${hr.usageBaselineThrough}` });
    }
    const usage = summarizeUsage(counted, fy, policy, type, { countFrom: fy.start });
    flags.push(...usage.flags);
    const used = baselineDays + usage.usedDays;

    let available = hr.entitlementDays;
    let carryover = null;
    if (type === 'vacation') {
      if (hr.carryoverDays === null || hr.carryoverDays === undefined) {
        status = STATUS.UNKNOWN;
        missing.push('vacationCarryoverDays');
      } else {
        carryover = hr.carryoverDays;
        available += carryover;
        const cap = tenYearStatus(policy, { continuousServiceStart: profile?.continuousServiceStart || null }, fy) === 'yes'
          ? policy.vacation.combinedCapDaysAfter10YearsContinuous : policy.vacation.combinedCapDays;
        if (available > policy.vacation.combinedCapDaysAfter10YearsContinuous) flags.push({ code: 'vacation_cap_exceeded', detail: `HR total ${available} exceeds the highest cap ${policy.vacation.combinedCapDaysAfter10YearsContinuous}` });
        else if (available > cap) flags.push({ code: 'vacation_cap_unverified', detail: `HR total ${available} exceeds ${cap}; 10-year continuity is not confirmed` });
      }
    }

    if (engineOut.status === STATUS.OK && engineOut.availableDays !== null && status === STATUS.OK && Math.abs(engineOut.availableDays - available) > 1e-9) {
      flags.push({ code: 'hr_differs_from_policy', detail: `policy ${engineOut.availableDays}, HR ${available}` });
    }
    if (eligibility.status === 'needs_hr') flags.push({ code: 'eligibility_from_hr_row' });
    if (engineOut.status === STATUS.PENDING_POLICY) flags.push({ code: 'policy_pending_hr_verified' });

    const uncovered = uncoveredMonths(fy, covered, today, hr.usageBaselineThrough);
    const usageComplete = uncovered.length === 0;
    if (!usageComplete) reasons.push('usage_coverage_incomplete');

    const ok = status === STATUS.OK;
    return {
      status, reasons, missing, candidates: null, source: 'hr_verified', kind: engineOut.kind || policy[type].kind,
      entitlementDays: hr.entitlementDays, carryoverDays: carryover,
      availableDays: ok ? available : null, usedDays: used,
      remainingDays: ok && usageComplete ? Math.max(0, available - used) : null,
      overAllowanceDays: ok && usageComplete ? Math.max(0, used - available) : null,
      usageComplete, uncoveredMonths: uncovered, flags,
    };
  }

  /** Result row built from the engine's own output (no HR row for this type). */
  function fromEngine({ out, fy, covered, today }) {
    const uncovered = out.status === STATUS.OK ? uncoveredMonths(fy, covered, today, null) : [];
    const usageComplete = uncovered.length === 0;
    const reasons = [...out.reasons];
    if (!usageComplete) reasons.push('usage_coverage_incomplete');
    const ok = out.status === STATUS.OK;
    return {
      status: out.status, reasons, missing: out.missing, candidates: out.candidates, source: ok ? 'computed' : null, kind: out.kind,
      entitlementDays: out.entitlementDays, carryoverDays: out.carryoverDays === undefined ? null : out.carryoverDays,
      availableDays: ok ? out.availableDays : null, usedDays: out.usedDays,
      remainingDays: ok && usageComplete ? out.remainingDays : null,
      overAllowanceDays: ok && usageComplete ? out.overAllowanceDays : null,
      usageComplete, uncoveredMonths: uncovered, flags: out.flags,
    };
  }

  return {
    /**
     * @param {string} employeeUid
     * @param {number} fiscalYearBe e.g. 2570
     * @returns {Promise<object[]>} one row per leave type, in the shape of the existing balance rows plus the
     *   status/source/flag fields described in the Phase 2 plan §4.
     */
    async balance(employeeUid, fiscalYearBe) {
      const fy = fiscalYearByBE(fiscalYearBe);
      const [facts, profile, hrRows, records, covered] = await Promise.all([
        repositories.employees.getLeaveFacts(employeeUid),
        repositories.leaveHr.getProfile(employeeUid),
        repositories.leaveHr.listEntitlements(employeeUid, fiscalYearBe),
        engineRecords(employeeUid),
        coveredMonths(),
      ]);
      if (!facts) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      return computeRows({ employeeUid, fiscalYearBe, fy, facts, profile, hrRows, records, covered, today: bangkokDate(now()) });
    },

    /**
     * The same rows as `balance` for MANY employees with a fixed number of queries (facts, profiles, HR rows,
     * leave records, legacy leave, coverage) however many people there are. Both paths share `computeRows`, so a
     * person's row is identical either way. Authorization (which people) is the caller's job.
     * @returns {Promise<Map<string, object[]>>} employeeUid -> rows (one per leave type); unknown uids are omitted
     */
    async balances(employeeUids, fiscalYearBe) {
      const fy = fiscalYearByBE(fiscalYearBe);
      const uids = [...new Set(employeeUids)];
      const [factsList, profiles, hrRows, records, legacy, covered] = await Promise.all([
        repositories.employees.listLeaveFacts(uids),
        repositories.leaveHr.listProfiles(uids),
        repositories.leaveHr.listEntitlementsForYear(uids, fiscalYearBe),
        typeof repositories.leaveRecords?.listBetween === 'function' ? repositories.leaveRecords.listBetween(fy.start, fy.end) : [],
        repositories.leave.listOverlapping(fy.start, fy.end),
        coveredMonths(),
      ]);
      const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.employeeUid)) m.set(r.employeeUid, []); m.get(r.employeeUid).push(r); } return m; };
      const profileBy = new Map(profiles.map((p) => [p.employeeUid, p]));
      const hrBy = group(hrRows);
      const recordsBy = group(records);
      const legacyBy = group(legacy);
      const today = bangkokDate(now());
      const out = new Map();
      for (const facts of factsList) {
        const uid = facts.employeeUid;
        out.set(uid, computeRows({
          employeeUid: uid, fiscalYearBe, fy, facts, profile: profileBy.get(uid) || null, hrRows: hrBy.get(uid) || [],
          records: toEngineRecords(recordsBy.get(uid) || [], legacyBy.get(uid) || []), covered, today,
        }));
      }
      return out;
    },
  };

  function computeRows({ employeeUid, fiscalYearBe, fy, facts, profile, hrRows, records, covered, today }) {
    const hrByType = new Map(hrRows.map((row) => [row.leaveType, row]));
    const vacationHr = hrByType.get('vacation');

    // An HR row for a type is HR's confirmation for the year, so it settles a `needs_hr` type; an explicit
    // denial (or outsourced staff) is never overridden by a stored number.
    const employee = engineEmployee(facts, profile);
    const eligibility = classifyEligibility(employee, policyForDate(fy.end) || POLICIES[0]);
    const carryover = { vacationDays: vacationHr ? (vacationHr.carryoverDays ?? null) : null };
    // `actual` is what the facts say. `assumed` is the same person treated as confirmed by HR; it is used only
    // to compare against a type that HR has a verified row for, never to produce a number for a type without one.
    const asIfConfirmed = hrRows.length > 0 && eligibility.status === 'needs_hr';
    const actual = computeEntitlements({ fiscalYear: fiscalYearBe, records, carryover, employee });
    const assumed = asIfConfirmed
      ? computeEntitlements({ fiscalYear: fiscalYearBe, records, carryover, employee: { ...employee, eligibilityConfirmation: { confirmed: true, reference: 'hr-verified-entitlement-row' } } })
      : actual;
    const engine = actual;

    return TYPES.map((type) => {
      const hr = hrByType.get(type);
      const out = actual.results[type];
      let row;
      if (hr && eligibility.status !== 'out_of_scope' && out.status !== STATUS.NOT_STARTED) {
        row = fromHr({ type, hr, engineOut: assumed.results[type], fy, profile, records, covered, today, eligibility });
      } else {
        row = fromEngine({ out, fy, covered, today });
        if (hr) row.flags = [...row.flags, { code: 'hr_row_ignored_out_of_scope' }];
      }
      const available = row.status === STATUS.OK && row.remainingDays !== null;
      return {
        employeeUid,
        year: fiscalYearBe,
        basis: 'fiscal',
        fiscalYear: { be: fy.be, start: fy.start, end: fy.end },
        policyVersion: engine.policyVersion,
        leaveType: type,
        typeLabel: TYPE_LABEL[type],
        // Existing balance-row fields keep their meaning; they are null whenever the value is not determined.
        totalDays: row.availableDays,
        usedDays: row.usedDays,
        pendingDays: pendingDaysOf(records, fy, type),
        remainingDays: row.remainingDays,
        available,
        unavailableReason: available ? null : (row.status === STATUS.OK ? 'deductions_not_tracked' : 'no_entitlement'),
        ...row,
      };
    });
  }
}

module.exports = { createLeaveEntitlementService, bangkokDate };
