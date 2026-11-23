const { createHash, randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { createLeaveEntitlementService, bangkokDate } = require('./leaveEntitlementService');
const { fiscalYearByBE } = require('../domain/leavePolicyEngine');
const { familyForType } = require('../domain/leavePolicySection');

const LEAVE_TYPES = ['sick', 'personal', 'vacation'];
const APPOINTMENT_KINDS = ['first', 'rehire_after_resignation', 'rehire_after_dismissal', 'other'];
const SOURCE = 'owner-entry';
const same = (a, b) => (a ?? null) === (b ?? null);
const show = (v) => (v === null || v === undefined ? null : String(v));
const bad = (message) => new HttpError(400, 'VALIDATION_ERROR', message);

function realDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1950 && y <= 2100 && probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}
function optionalDate(value, field, today) {
  if (value === null) return null;
  if (typeof value !== 'string' || !realDate(value)) throw bad(`${field} must be a real date as YYYY-MM-DD, or null to clear it`);
  if (value > today) throw bad(`${field} cannot be in the future`);
  return value;
}
function days(value, field, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || !Number.isInteger(value * 2)) {
    throw bad(`${field} must be working days in steps of 0.5 between 0 and ${max}`);
  }
  return value;
}

/**
 * The owner's data entry: employment facts and entitlement overrides the system cannot know (hire date, continuous
 * service, appointment kind, the eligibility decision, vacation carry-over, an entitlement for one fiscal year).
 *
 *  - EXECUTIVE with an organization grant only (the same gate as leave review). Everyone else gets 403.
 *  - A key that is absent is left alone; `null` clears a value; nothing is guessed or defaulted, except that a
 *    confirmed eligibility without a reference is recorded as "owner-confirmed <date>" so the decision is traceable.
 *  - Writes reuse the HR import's tables and audit: one batch per kind, one audit row per changed field, all in
 *    one transaction (a failure leaves nothing behind). It never touches leave records, approvals or credentials.
 */
function createLeaveOwnerEntryService({ repositories, now = () => new Date() }) {
  const entitlement = createLeaveEntitlementService({ repositories, now });

  async function requireOwner(auth) {
    const scope = await resolveScope(auth, repositories, 'data');
    if (!scope.all) throw new HttpError(403, 'FORBIDDEN', 'Only an executive with an organization grant can enter leave data');
  }

  function parse(payload, today) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bad('a JSON object is required');
    const known = ['hireDate', 'continuousServiceStart', 'appointmentKind', 'eligibility', 'entitlements'];
    const unknown = Object.keys(payload).filter((k) => !known.includes(k));
    if (unknown.length) throw bad(`unknown field: ${unknown[0]}`);
    const out = { employee: {}, profile: {}, entitlements: [] };
    if ('hireDate' in payload) out.employee.hireDate = optionalDate(payload.hireDate, 'hireDate', today);
    if ('continuousServiceStart' in payload) out.profile.continuousServiceStart = optionalDate(payload.continuousServiceStart, 'continuousServiceStart', today);
    if ('appointmentKind' in payload) {
      if (payload.appointmentKind !== null && !APPOINTMENT_KINDS.includes(payload.appointmentKind)) throw bad('appointmentKind is not recognised');
      out.profile.appointmentKind = payload.appointmentKind;
    }
    if ('eligibility' in payload) {
      const e = payload.eligibility;
      if (e === null || (typeof e === 'object' && e.confirmed === null)) { out.profile.eligibilityConfirmed = null; out.profile.eligibilityReference = null; }
      else if (typeof e === 'object' && typeof e.confirmed === 'boolean') {
        const ref = e.reference === undefined || e.reference === null || String(e.reference).trim() === '' ? `owner-confirmed ${today}` : String(e.reference).trim();
        if (ref.length > 120) throw bad('eligibility.reference is at most 120 characters');
        out.profile.eligibilityConfirmed = e.confirmed; out.profile.eligibilityReference = ref;
      } else throw bad('eligibility must be { confirmed: true|false|null, reference? }');
    }
    if ('entitlements' in payload) {
      if (!Array.isArray(payload.entitlements) || payload.entitlements.length > 12) throw bad('entitlements must be a list of at most 12 rows');
      const seen = new Set();
      for (const e of payload.entitlements) {
        if (!e || typeof e !== 'object') throw bad('each entitlement must be an object');
        if (!Number.isInteger(e.fiscalYearBe) || e.fiscalYearBe < 2569 || e.fiscalYearBe > 2700) throw bad('fiscalYearBe must be a Buddhist-era year such as 2570');
        if (!LEAVE_TYPES.includes(e.leaveType)) throw bad('leaveType must be sick, personal or vacation');
        const key = `${e.fiscalYearBe}|${e.leaveType}`;
        if (seen.has(key)) throw bad('an entitlement is listed twice');
        seen.add(key);
        if (e.remove === true) { out.entitlements.push({ fiscalYearBe: e.fiscalYearBe, leaveType: e.leaveType, remove: true }); continue; }
        const row = { fiscalYearBe: e.fiscalYearBe, leaveType: e.leaveType, remove: false };
        row.entitlementDays = days(e.entitlementDays, 'entitlementDays', 120);
        row.carryoverDays = e.carryoverDays === undefined || e.carryoverDays === null ? null : days(e.carryoverDays, 'carryoverDays', 30);
        if (row.carryoverDays !== null && e.leaveType !== 'vacation') throw bad('carryoverDays applies to vacation only');
        const hasDays = e.usageBaselineDays !== undefined && e.usageBaselineDays !== null;
        const hasThrough = e.usageBaselineThrough !== undefined && e.usageBaselineThrough !== null;
        if (hasDays !== hasThrough) throw bad('usageBaselineDays and usageBaselineThrough go together');
        row.usageBaselineDays = hasDays ? days(e.usageBaselineDays, 'usageBaselineDays', 120) : null;
        row.usageBaselineThrough = hasThrough ? optionalDate(e.usageBaselineThrough, 'usageBaselineThrough', today) : null;
        if (row.usageBaselineThrough) {
          const fy = fiscalYearByBE(e.fiscalYearBe);
          if (row.usageBaselineThrough < fy.start || row.usageBaselineThrough > fy.end) throw bad('usageBaselineThrough must fall inside the fiscal year');
        }
        out.entitlements.push(row);
      }
    }
    if (!Object.keys(out.employee).length && !Object.keys(out.profile).length && !out.entitlements.length) throw bad('nothing to change');
    return out;
  }

  return {
    /** @returns {{ changed: number, rows: object[] }} the number of changed fields and the person's fresh balance rows for the year of the first entitlement (or the current fiscal year). */
    async apply(auth, employeeUid, payload, { fiscalYearBe } = {}) {
      await requireOwner(auth);
      const today = bangkokDate(now());
      const input = parse(payload, today);
      const facts = await repositories.employees.getLeaveFacts(employeeUid);
      if (!facts) throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      // The policy of this person decides what may be entered (a section policy has no carry-over).
      const family = familyForType(facts.employeeType);
      if (family !== 'university' && family !== null && Array.isArray(payload?.entitlements)
        && payload.entitlements.some((e) => e && typeof e.carryoverDays === 'number' && e.carryoverDays > 0)) {
        throw bad('this leave policy has no vacation carry-over; carryoverDays must be 0 or left empty');
      }
      const profileNow = await repositories.leaveHr.getProfile(employeeUid);
      const operator = auth.employeeUid;

      const profileChanges = [];
      let hireDate = null;
      if ('hireDate' in input.employee && !same(input.employee.hireDate, facts.hireDate)) {
        hireDate = input.employee.hireDate;
        profileChanges.push({ table: 'employees', field: 'hire_date', before: facts.hireDate, after: hireDate });
      }
      const merged = {
        continuousServiceStart: profileNow?.continuousServiceStart ?? null, appointmentKind: profileNow?.appointmentKind ?? null,
        eligibilityConfirmed: profileNow?.eligibilityConfirmed ?? null, eligibilityReference: profileNow?.eligibilityReference ?? null,
      };
      const camelToSnake = { continuousServiceStart: 'continuous_service_start', appointmentKind: 'appointment_kind', eligibilityConfirmed: 'eligibility_confirmed', eligibilityReference: 'eligibility_reference' };
      let profileTouched = false;
      for (const [field, value] of Object.entries(input.profile)) {
        if (same(value, merged[field])) continue;
        profileChanges.push({ table: 'employee_leave_profile', field: camelToSnake[field], before: merged[field], after: value });
        merged[field] = value; profileTouched = true;
      }

      const entitlementPlans = [];
      for (const e of input.entitlements) {
        const stored = await repositories.leaveHr.getEntitlement(employeeUid, e.fiscalYearBe, e.leaveType);
        const key = `${e.fiscalYearBe}|${e.leaveType}`;
        if (e.remove) {
          if (!stored) continue;
          entitlementPlans.push({ e, key, remove: true, changes: [{ table: 'employee_leave_entitlement', field: 'entitlement_days', before: stored.entitlementDays, after: null, entityKey: key }] });
          continue;
        }
        const changes = [];
        for (const [field, snake] of [['entitlementDays', 'entitlement_days'], ['carryoverDays', 'carryover_days'], ['usageBaselineDays', 'usage_baseline_days'], ['usageBaselineThrough', 'usage_baseline_through']]) {
          if (!same(e[field], stored ? stored[field] : null)) changes.push({ table: 'employee_leave_entitlement', field: snake, before: stored ? stored[field] : null, after: e[field], entityKey: key });
        }
        if (changes.length) entitlementPlans.push({ e, key, remove: false, changes });
      }

      const changed = profileChanges.length + entitlementPlans.reduce((n, p) => n + p.changes.length, 0);
      if (changed > 0) {
        const nonce = randomUUID();
        const sha = (kind) => createHash('sha256').update(`${SOURCE}|${kind}|${employeeUid}|${nonce}|${JSON.stringify(payload)}`).digest('hex');
        await repositories.leaveHr.transaction(async (tx) => {
          const audit = (batchUid, c) => ({ batchUid, employeeUid, tableName: c.table, fieldName: c.field, entityKey: c.entityKey ?? null, beforeValue: show(c.before), afterValue: show(c.after), actorUid: operator });
          if (profileChanges.length) {
            const batchUid = await tx.insertBatch({ kind: 'profile', fileSha256: sha('profile'), rowsRead: 1, rowsApplied: 1, rowsUnchanged: 0, operatorUid: operator });
            if (profileChanges.some((c) => c.table === 'employees')) await tx.setHireDate(employeeUid, hireDate);
            if (profileTouched) {
              await tx.upsertProfile({
                ...merged, employeeUid, sourceReference: SOURCE, verifiedByUid: operator,
              });
            }
            await tx.appendAudit(profileChanges.map((c) => audit(batchUid, c)));
          }
          if (entitlementPlans.length) {
            const batchUid = await tx.insertBatch({ kind: 'entitlement', fileSha256: sha('entitlement'), rowsRead: entitlementPlans.length, rowsApplied: entitlementPlans.length, rowsUnchanged: 0, operatorUid: operator });
            for (const p of entitlementPlans) {
              if (p.remove) await tx.deleteEntitlement(employeeUid, p.e.fiscalYearBe, p.e.leaveType);
              else {
                await tx.upsertEntitlement({
                  employeeUid, fiscalYearBe: p.e.fiscalYearBe, leaveType: p.e.leaveType, entitlementDays: p.e.entitlementDays, carryoverDays: p.e.carryoverDays,
                  usageBaselineDays: p.e.usageBaselineDays, usageBaselineThrough: p.e.usageBaselineThrough, sourceReference: SOURCE, importBatchUid: batchUid, verifiedByUid: operator,
                });
              }
            }
            await tx.appendAudit(entitlementPlans.flatMap((p) => p.changes.map((c) => audit(batchUid, c))));
          }
        });
      }
      const year = fiscalYearBe || input.entitlements[0]?.fiscalYearBe;
      const rows = year ? await entitlement.balance(employeeUid, year) : [];
      return { changed, rows };
    },
  };
}

module.exports = { createLeaveOwnerEntryService };
