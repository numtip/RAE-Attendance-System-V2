/**
 * Identity kinds: which authority a person's primary identity reference comes from.
 *
 *   MJU         primary reference = personnel_id issued by MJU (source_system 'mju_person_api')
 *   HIP         contractor without MJU data: primary reference = HIP/FaceScan id (facescan_id) from the
 *               approved IDCardRaecsv2027 batch; NO personnel_id, NO SSO subject
 *   UNRESOLVED  cannot be classified safely (missing/untrusted source, conflict, collision)
 *
 * The kind is DERIVED from active employee_identifier rows (type + source_system); it is not a free-text
 * column that could drift from the identifiers. A synthetic personnel_id (any other source) is a violation.
 * Values are namespaced by id_type: a HIP code and a personnel_id with the same text are different identifiers
 * and must never belong to different employees (namespace collision).
 */

const IDENTITY_KIND = Object.freeze({ MJU: 'MJU', HIP: 'HIP', UNRESOLVED: 'UNRESOLVED' });

/** source_system of personnel_id rows that came from the authoritative MJU Person API. */
const MJU_PERSONNEL_SOURCE = 'mju_person_api';
/** source_system of facescan_id rows staged from the approved HIP ID card batch. */
const HIP_BATCH_SOURCE = 'IDCardRaecsv2027';

/** The two value namespaces that must not collide across different employees. */
const NAMESPACE_PAIR = Object.freeze({ facescan_id: 'personnel_id', personnel_id: 'facescan_id' });

/**
 * SSO eligibility is INDEPENDENT of attendance eligibility.
 *   MJU         eligible on first verified MJU login (subject is linked then, never created by us)
 *   HIP         NOT_REQUIRED: no MJU account needed. If an MJU account exists later, a verified login whose
 *               protected National ID matches may link the subject to the same employee_uid (upgrade path).
 *   UNRESOLVED  NOT_ELIGIBLE until classified
 * Nothing here creates an SSO subject or forces MJU SSO.
 */
function ssoPolicyForKind(kind) {
  const eligibility = {
    [IDENTITY_KIND.MJU]: 'ELIGIBLE_ON_FIRST_MJU_LOGIN',
    [IDENTITY_KIND.HIP]: 'NOT_REQUIRED',
  }[kind] || 'NOT_ELIGIBLE';
  return Object.freeze({
    required: false,
    eligibility,
    // Only an MJU-verified login callback may create an identity link; no import/onboarding path may.
    linkAllowedFrom: kind === IDENTITY_KIND.UNRESOLVED ? 'none' : 'verified_sso_callback_only',
    createSubject: false,
  });
}

/** Attendance (FaceScan/HIP) eligibility depends only on an active, non-empty facescan_id: never on SSO or MJU. */
function attendanceEligibility(identifiers = []) {
  const active = identifiers.filter((row) => !row.status || row.status === 'active');
  const facescan = active.find((row) => (row.idType ?? row.id_type) === 'facescan_id');
  return Object.freeze({ eligible: Boolean(facescan), via: facescan ? 'facescan_id' : null, requiresMjuSso: false });
}
function isActive(row) {
  return !row.status || row.status === 'active';
}

/**
 * @param {Array<{idType:string, sourceSystem?:string|null, status?:string}>} identifiers rows of ONE employee
 * @returns {{kind:string, violations:string[]}}
 */
function deriveIdentityKind(identifiers = []) {
  const active = identifiers.filter(isActive).map((row) => ({
    idType: row.idType ?? row.id_type,
    sourceSystem: row.sourceSystem ?? row.source_system ?? null,
  }));
  const personnel = active.filter((row) => row.idType === 'personnel_id');
  const facescan = active.filter((row) => row.idType === 'facescan_id');
  const violations = [];

  if (personnel.some((row) => row.sourceSystem !== MJU_PERSONNEL_SOURCE)) {
    violations.push('PERSONNEL_ID_NOT_FROM_MJU');
  }
  if (personnel.length > 1) violations.push('MULTIPLE_PERSONNEL_IDS');
  if (violations.length) return { kind: IDENTITY_KIND.UNRESOLVED, violations };

  if (personnel.length === 1) return { kind: IDENTITY_KIND.MJU, violations };
  if (facescan.some((row) => row.sourceSystem === HIP_BATCH_SOURCE)) return { kind: IDENTITY_KIND.HIP, violations };
  return { kind: IDENTITY_KIND.UNRESOLVED, violations };
}

module.exports = {
  IDENTITY_KIND,
  MJU_PERSONNEL_SOURCE,
  HIP_BATCH_SOURCE,
  NAMESPACE_PAIR,
  ssoPolicyForKind,
  attendanceEligibility,
  deriveIdentityKind,
};
