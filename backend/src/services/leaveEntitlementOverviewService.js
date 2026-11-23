const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { createLeaveEntitlementService, bangkokDate } = require('./leaveEntitlementService');
const { fiscalYearOf, fiscalYearByBE, STATUS } = require('../domain/leavePolicyEngine');
const { DIVISIONS } = require('../config/organization');
const { TYPE_LABEL } = require('./leaveLabels');

const TYPES = ['sick', 'personal', 'vacation'];
const MIN_FY = 2569;
const MAX_FY = 2700;

/** The fields of one engine row the dashboard needs (flags are reduced to codes: no free text leaves the server). */
function slim(row) {
  return {
    status: row.status, source: row.source, available: row.available,
    entitlementDays: row.entitlementDays ?? null, carryoverDays: row.carryoverDays ?? null, totalDays: row.totalDays ?? null,
    usedDays: row.usedDays ?? null, pendingDays: row.pendingDays ?? null, remainingDays: row.remainingDays ?? null,
    usageComplete: row.usageComplete, missing: row.missing || [], reasons: row.reasons || [],
    flags: (row.flags || []).map((f) => f.code),
  };
}

/**
 * Organisation-wide fiscal-year entitlement overview: ONE request for everyone the caller may see. It runs a fixed
 * number of queries (the entitlement service's bulk path), never one per employee. A person with missing data
 * shows `unknown` / `needs_hr` / ... for the affected types only; everyone else is unaffected. Totals add up only
 * rows whose balance is determined, so an incomplete person is left out of a sum, never counted as zero.
 *
 * Access: an executive with an organization grant sees everyone; a manager sees the people in the granted org
 * units; anyone else is refused (a personal balance already has its own endpoint). Only the all-organisation
 * executive also receives the stored employment facts (hire date, continuity, appointment kind, eligibility
 * decision), which are what the owner entry screen edits.
 */
function createLeaveEntitlementOverviewService({ repositories, config, now = () => new Date() }) {
  const entitlement = createLeaveEntitlementService({ repositories, now });
  const engineFlag = () => (config && config.leave && config.leave.entitlementEngine) || 'off';

  async function divisionLookup() {
    const memberships = typeof repositories.authorization.listMemberships === 'function' ? await repositories.authorization.listMemberships() : [];
    const codes = new Map();
    for (const { employeeUid, orgUnitCode } of memberships) {
      if (!DIVISIONS.some((d) => d.code === orgUnitCode)) continue;
      if (!codes.has(employeeUid)) codes.set(employeeUid, new Set());
      codes.get(employeeUid).add(orgUnitCode);
    }
    return (uid) => {
      const set = codes.get(uid);
      if (!set || set.size === 0) return 'unassigned';
      return set.size > 1 ? 'ambiguous' : [...set][0];
    };
  }
  const divisionName = (code) => (DIVISIONS.find((d) => d.code === code) || {}).nameTh
    || (code === 'ambiguous' ? 'สังกัดมากกว่าหนึ่งกอง' : 'ไม่ระบุสังกัดกอง');

  return {
    assertEnabled() {
      // `shadow` is the validation stage: the overview may be read, the per-person legacy responses stay as they are.
      if (engineFlag() === 'off') throw new HttpError(503, 'LEAVE_ENTITLEMENT_ENGINE_OFF', 'Fiscal-year leave entitlements are not enabled');
    },

    async overview(auth, query = {}) {
      this.assertEnabled();
      const today = bangkokDate(now());
      const year = query.year === undefined || query.year === '' ? fiscalYearOf(today).be : Number(query.year);
      if (!Number.isInteger(year) || year < MIN_FY || year > MAX_FY) throw new HttpError(400, 'VALIDATION_ERROR', 'a fiscal year is a Buddhist-era year such as 2570');
      if (query.division && !DIVISIONS.some((d) => d.code === query.division)) throw new HttpError(400, 'VALIDATION_ERROR', 'division is invalid');

      const scope = await resolveScope(auth, repositories, 'data');
      if (!(scope.all || scope.broad)) throw new HttpError(403, 'FORBIDDEN', 'The organisation overview needs an executive or manager role');

      const divisionOf = await divisionLookup();
      let people = (await repositories.employees.list())
        .filter((e) => e.status === undefined || e.status === 'active')
        .filter((e) => scope.all || scope.uids.has(e.employeeUid))
        .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));
      if (query.division) people = people.filter((e) => divisionOf(e.employeeUid) === query.division);

      const uids = people.map((p) => p.employeeUid);
      const [rowsByUid, facts, profiles, stored] = await Promise.all([
        entitlement.balances(uids, year),
        repositories.employees.listLeaveFacts(uids),
        scope.all ? repositories.leaveHr.listProfiles(uids) : [],
        scope.all ? repositories.leaveHr.listEntitlementsForYear(uids, year) : [],
      ]);
      const storedBy = new Map();
      for (const r of stored) {
        if (!storedBy.has(r.employeeUid)) storedBy.set(r.employeeUid, {});
        storedBy.get(r.employeeUid)[r.leaveType] = {
          entitlementDays: r.entitlementDays, carryoverDays: r.carryoverDays, usageBaselineDays: r.usageBaselineDays, usageBaselineThrough: r.usageBaselineThrough,
        };
      }
      const factBy = new Map(facts.map((f) => [f.employeeUid, f]));
      const profileBy = new Map(profiles.map((p) => [p.employeeUid, p]));

      const summary = {
        headcount: people.length, inPolicy: 0, excluded: 0, unconfirmed: 0, fullyDetermined: 0,
        byType: Object.fromEntries(TYPES.map((t) => [t, { label: TYPE_LABEL[t], byStatus: {}, determined: 0, entitlementDays: 0, usedDays: 0, remainingDays: 0, missing: {} }])),
        missing: {},
      };
      const rows = people.map((p) => {
        const typeRows = rowsByUid.get(p.employeeUid) || [];
        const byType = {};
        for (const r of typeRows) byType[r.leaveType] = slim(r);
        const statuses = TYPES.map((t) => byType[t]?.status);
        const scopeState = statuses.every((s) => s === STATUS.OUT_OF_SCOPE) ? 'excluded'
          : (statuses.some((s) => s === STATUS.NEEDS_HR) ? 'unconfirmed' : 'in_policy');
        summary[{ excluded: 'excluded', unconfirmed: 'unconfirmed', in_policy: 'inPolicy' }[scopeState]] += 1;
        const missing = [...new Set(TYPES.flatMap((t) => byType[t]?.missing || []))];
        if (scopeState !== 'excluded') for (const m of missing) summary.missing[m] = (summary.missing[m] || 0) + 1;
        let determined = 0;
        for (const t of TYPES) {
          const cell = byType[t];
          if (!cell) continue;
          const bucket = summary.byType[t];
          bucket.byStatus[cell.status] = (bucket.byStatus[cell.status] || 0) + 1;
          if (scopeState !== 'excluded') for (const m of cell.missing) bucket.missing[m] = (bucket.missing[m] || 0) + 1;
          if (cell.available && cell.remainingDays !== null) {
            determined += 1; bucket.determined += 1;
            bucket.entitlementDays += cell.totalDays; bucket.usedDays += cell.usedDays; bucket.remainingDays += cell.remainingDays;
          }
        }
        if (determined === TYPES.length) summary.fullyDetermined += 1;
        const fact = factBy.get(p.employeeUid);
        const profile = profileBy.get(p.employeeUid);
        const code = divisionOf(p.employeeUid);
        return {
          employeeUid: p.employeeUid, employeeId: p.employeeId, name: `${p.firstNameTh || ''} ${p.lastNameTh || ''}`.trim(),
          employeeType: p.employeeType, division: { code, nameTh: divisionName(code) },
          scope: scopeState, missing, types: byType,
          ...(scope.all ? {
            profile: {
              hireDate: fact?.hireDate ?? null, continuousServiceStart: profile?.continuousServiceStart ?? null,
              appointmentKind: profile?.appointmentKind ?? null, eligibilityConfirmed: profile?.eligibilityConfirmed ?? null,
              eligibilityReference: profile?.eligibilityReference ?? null,
            },
            stored: storedBy.get(p.employeeUid) || {},
          } : {}),
        };
      });
      const fy = fiscalYearByBE(year);
      return {
        fiscalYear: { be: year, start: fy.start, end: fy.end }, flag: engineFlag(), canEdit: Boolean(scope.all),
        types: TYPES.map((t) => ({ type: t, labelTh: TYPE_LABEL[t] })),
        divisions: DIVISIONS.map((d) => ({ code: d.code, nameTh: d.nameTh })),
        summary, rows,
      };
    },
  };
}

module.exports = { createLeaveEntitlementOverviewService };
