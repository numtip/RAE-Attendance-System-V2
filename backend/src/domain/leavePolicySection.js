/**
 * Leave policies for พนักงานส่วนงาน and พนักงานส่วนงานจ้างเหมา — rule VALUES as versioned data, next to the
 * university policy in leavePolicy2569.js (which is NOT touched). Reference: docs/policies/RAE_SECTION_CONTRACT_LEAVE_POLICY.md.
 *
 * Three policy FAMILIES, one per employment type (employees.employee_type):
 *   university        -> MJU-LEAVE-2569               (sick 60 / personal 45 / vacation 10, carry-over cap 20/30)
 *   section_employee  -> RAE-SECTION-EMPLOYEE-2569    (15 / 5 / 10; personal needs 3 months, vacation 6 months; no carry-over)
 *   section_contract  -> RAE-SECTION-CONTRACT-2569-V2 (10 / 5 / 10; no tenure condition; no carry-over)
 *   procurement_academic has NO mapped family: the owner has not said which policy applies, so it stays `needs_hr`
 *   and a confirmation cannot pick a policy for it.
 *
 * Nothing here is anyone's verified entitlement; it is what the policy says. A policy that has been used to compute a
 * balance is never edited: it is superseded by a new id.
 */
const { POLICIES: UNIVERSITY_POLICIES } = require('./leavePolicy2569');

const SECTION_EMPLOYEE_2569 = Object.freeze({
  id: 'RAE-SECTION-EMPLOYEE-2569',
  family: 'section_employee',
  source: 'S1: ประกาศ กบม. ว่าด้วยการลาของพนักงานส่วนงาน ลงวันที่ 20 ส.ค. 2569 (หน้า 8), มีผลวันถัดไป (ข้อ 2)',
  effectiveFrom: '2026-08-21',
  announcedOn: '2026-08-20',
  repeals: 'ประกาศลงวันที่ 16 พฤศจิกายน 2566',
  yearBasis: 'fiscal',
  fiscalYearStartMonth: 10,
  unit: 'working_day',
  // พนักงานส่วนงาน (employee_type `department`) is the subject of this announcement (clause 4).
  employeeTypes: Object.freeze({ department: 'eligible' }),

  sick: Object.freeze({
    clauses: Object.freeze([13, 14]),
    kind: 'paid_leave_allowance',
    paidDaysPerFiscalYear: 15,
    // Clause 14: 3 working days or more need a medical certificate. A review flag only; it never decides approval.
    medicalCertificate: Object.freeze({ fromWorkingDays: 3, comparison: 'gte' }),
  }),
  personal: Object.freeze({
    clauses: Object.freeze([15, 16]),
    kind: 'paid_leave_allowance',
    paidDaysPerFiscalYear: 5,
    minServiceMonths: 3, // under 3 months of service: no personal-leave right
    minDaysPerRequest: 0.5,
  }),
  vacation: Object.freeze({
    clauses: Object.freeze([17, 18]),
    kind: 'leave_right',
    daysPerFiscalYear: 10,
    minServiceMonths: 6, // under 6 months of service: no vacation right
    minDaysPerRequest: 1,
    minAdvanceNoticeDays: 3,
    carryoverAllowed: false,
  }),
  nonDeductibleException: null, // the university clause-14 exception is not part of this announcement
});

/**
 * พนักงานส่วนงานจ้างเหมา — source S2 (docs/policies/00pork.MD), which gives limits only.
 *
 * OWNER DECISION 2026-11-23: personal leave is 5 working days per fiscal year. This supersedes the 10 days that an
 * earlier draft of the reference file showed in its comparison table (S2 itself says 5). Version 1 (personal 10) was
 * never deployed; V2 is the first version used to compute a balance.
 *
 * What S2 does not say is NOT filled in from another group's rules: no effective date (so `effectiveFrom` is null and
 * every result carries `policy_effective_date_unspecified`), no minimum service, no prorating, no half-day rule, no
 * statement on pay during leave (kind `annual_limit`, not `paid_leave_allowance`).
 */
const SECTION_CONTRACT_2569_V2 = Object.freeze({
  id: 'RAE-SECTION-CONTRACT-2569-V2',
  family: 'section_contract',
  version: 2,
  supersedes: 'RAE-SECTION-CONTRACT-2569-V1 (personal 10 days; never deployed)',
  source: 'S2: docs/policies/00pork.MD — หลักเกณฑ์การลา พนักงานส่วนงานจ้างเหมา สำนักวิจัยฯ',
  ownerDecisions: Object.freeze([
    Object.freeze({ date: '2026-11-23', decision: 'sick 10 / personal 5 / vacation 10 working days per fiscal year; no vacation carry-over; personal leave is 5 (supersedes 10)' }),
  ]),
  effectiveFrom: null, // not stated in S2: the engine does not guess it
  // NOT an effective date. S2 must not be backfilled, so no fiscal year before the one in which the owner confirmed this
  // policy (FY2570, from 2026-10-01) is calculated: earlier years stay `pending_policy` until the owner states the period.
  applicableFromFiscalYearBe: 2570,
  yearBasis: 'fiscal',
  fiscalYearStartMonth: 10,
  unit: 'working_day',
  // `contract` = พนักงานส่วนงานจ้างเหมา (the registry label). The owner confirms each person before any number is shown.
  employeeTypes: Object.freeze({ contract: 'needs_hr' }),

  sick: Object.freeze({
    kind: 'annual_limit',
    paidDaysPerFiscalYear: 10,
    // S2: more than 3 working days needs a medical certificate. A review flag only.
    medicalCertificate: Object.freeze({ fromWorkingDays: 3, comparison: 'gt' }),
  }),
  personal: Object.freeze({ kind: 'annual_limit', paidDaysPerFiscalYear: 5, minDaysPerRequest: null }),
  vacation: Object.freeze({ kind: 'annual_limit', daysPerFiscalYear: 10, minDaysPerRequest: null, carryoverAllowed: false }),
  nonDeductibleException: null,
});

const ALL_POLICIES = Object.freeze([...UNIVERSITY_POLICIES, SECTION_EMPLOYEE_2569, SECTION_CONTRACT_2569_V2]);

/** employees.employee_type -> policy family. `null` = no policy is mapped (the owner must say which applies). */
const POLICY_FAMILY_BY_TYPE = Object.freeze({
  university: 'university',
  department: 'section_employee',
  contract: 'section_contract',
  procurement_academic: null,
});

/**
 * What each family needs to know about a person. The owner screen, the importer and the readiness view ask for
 * these and nothing else: a section contract worker needs no hire date, a section employee needs no appointment kind
 * or continuous-service date, and only the university policy has a vacation carry-over to record.
 * `hireDateFor` lists the leave types whose number depends on the hire date.
 */
const FAMILIES = Object.freeze({
  university: Object.freeze({
    labelTh: 'พนักงานมหาวิทยาลัย', policyId: 'MJU-LEAVE-2569',
    requires: Object.freeze({ hireDateFor: ['personal', 'vacation'], continuousService: true, appointmentKind: true, carryover: true }),
  }),
  section_employee: Object.freeze({
    labelTh: 'พนักงานส่วนงาน', policyId: SECTION_EMPLOYEE_2569.id,
    requires: Object.freeze({ hireDateFor: ['personal', 'vacation'], continuousService: false, appointmentKind: false, carryover: false }),
  }),
  section_contract: Object.freeze({
    labelTh: 'พนักงานส่วนงานจ้างเหมา', policyId: SECTION_CONTRACT_2569_V2.id,
    requires: Object.freeze({ hireDateFor: [], continuousService: false, appointmentKind: false, carryover: false }),
  }),
});

const familyForType = (employeeType) => (Object.prototype.hasOwnProperty.call(POLICY_FAMILY_BY_TYPE, employeeType) ? POLICY_FAMILY_BY_TYPE[employeeType] : null);

module.exports = { SECTION_EMPLOYEE_2569, SECTION_CONTRACT_2569_V2, ALL_POLICIES, POLICY_FAMILY_BY_TYPE, FAMILIES, familyForType };
