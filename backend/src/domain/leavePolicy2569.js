/**
 * MJU leave policy 2569 — the rule VALUES, as versioned data.
 *
 * Source: ประกาศ กบม. เรื่อง หลักเกณฑ์ วิธีการ ประเภทการลา และอำนาจพิจารณาอนุญาตการลา ... ของพนักงานมหาวิทยาลัย
 * (signed 2026-08-20 / 20 ส.ค. 2569, effective the next day, clause 2) — verified against the scanned original on
 * 2026-11-23; see docs/policies/MJU_LEAVE_POLICY_2569.md for the clause-by-clause reference.
 *
 * These are the values of the announcement, NOT anyone's verified entitlement. The engine that reads them
 * (leavePolicyEngine.js) is pure and unwired: no service, route or migration uses it yet.
 *
 * Adding a new policy: append a new frozen object to POLICIES with its own `effectiveFrom`. Never edit a policy
 * that has been used to compute a balance; supersede it. A date earlier than the first `effectiveFrom` has no
 * policy and the engine reports `pending_policy` (the 2023-11-16 announcement this one repeals is not on file).
 */

const MJU_LEAVE_2569 = Object.freeze({
  id: 'MJU-LEAVE-2569',
  effectiveFrom: '2026-08-21',
  announcedOn: '2026-08-20',
  repeals: 'ประกาศ กบม. ลงวันที่ 16 พฤศจิกายน 2566',
  yearBasis: 'fiscal',
  fiscalYearStartMonth: 10,
  unit: 'working_day',

  /**
   * Personnel type (employees.employee_type) -> scope of this announcement.
   *  - `eligible`   : พนักงานมหาวิทยาลัย (clause 4).
   *  - `needs_hr`   : the announcement does not define the type; HR must confirm. NEVER treated as ineligible.
   *  - `out_of_scope`: outsourced staff (จ้างเหมา) are not พนักงานมหาวิทยาลัย under clause 4.
   * HR can settle a type per person with `employee.eligibilityConfirmation` (see the engine), no code change.
   */
  employeeTypes: Object.freeze({
    university: 'eligible',
    department: 'needs_hr', // พนักงานส่วนงาน: not a term in the announcement
    // OWNER DECISION 2026-11-23: นักวิชาการพัสดุ is explicitly covered by this policy (60/45/10 and every tenure, eligibility
    // and carry-over rule of it). No per-person confirmation is needed; an explicit `eligibilityConfirmation` still overrides.
    procurement_academic: 'eligible',
    contract: 'out_of_scope', // พนักงานส่วนงานจ้างเหมา
  }),

  sick: Object.freeze({
    clauses: Object.freeze([16, 17, 18]),
    kind: 'paid_leave_allowance', // paid days, NOT a ceiling on leave that may be taken
    paidDaysPerFiscalYear: 60,
    discretionaryExtraPaidDaysMax: 60, // clause 18: only if the rector decides; never automatic
    medicalCertificateFromConsecutiveDays: 30, // clause 17: per continuous leave, not the yearly total
  }),

  personal: Object.freeze({
    clauses: Object.freeze([19, 20, 21]),
    kind: 'paid_leave_allowance',
    paidDaysPerFiscalYear: 45,
    firstEmploymentYearPaidDays: 15,
    minDaysPerRequest: 0.5,
  }),

  vacation: Object.freeze({
    clauses: Object.freeze([22, 23, 24, 25, 26]),
    kind: 'leave_right',
    daysPerFiscalYear: 10,
    // Clause 23: no annual vacation right in the year of appointment while service is under 6 months, for these:
    noRightFirstMonths: 6,
    noRightAppointmentKinds: Object.freeze(['first', 'rehire_after_resignation', 'rehire_after_dismissal']),
    // Clause 24: carried-over days plus the current year's days may not exceed the cap.
    combinedCapDays: 20,
    combinedCapDaysAfter10YearsContinuous: 30,
    continuousServiceYearsForHigherCap: 10,
    minDaysPerRequest: 1, // clause 25
    minAdvanceNoticeDays: 3, // clause 25: "สามวัน", not working days
  }),

  halfDay: Object.freeze({ clause: 8, hours: 3.5, before: '12:00', after: '13:00', fraction: 0.5 }),

  /** Clause 14: the rector may order that days missed due to a special event are not counted as leave. */
  nonDeductibleException: Object.freeze({
    clause: 14,
    requiredEvidence: Object.freeze(['authorizedBy', 'reference']),
  }),

  /** Process requirements that the engine does not enforce but the platform must honour. */
  procedural: Object.freeze({
    electronicLeaveSystemRequired: true, // clause 11
    electronicLeaveSystemClause: 11,
    continuousSickOrPersonalIsOneRequestAcrossFiscalYears: true, // clause 6
  }),

  /** Clause 62 keeps existing entitlement for converted / continuously re-hired staff: never reset service. */
  continuityClause: 62,
});

const POLICIES = Object.freeze([MJU_LEAVE_2569]);

module.exports = { MJU_LEAVE_2569, POLICIES };
