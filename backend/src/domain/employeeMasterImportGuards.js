/**
 * Employee-master import guards: the "do not invent it" rules, as code.
 *
 * Every rule below is already on record; this module exists so a future import cannot quietly satisfy a
 * NOT NULL by writing a plausible-looking value.
 *
 *  * D-2026-10-20-03 — employment dates stay unverified; nothing is invented to populate a NOT NULL column or
 *    `employee_assignment`. An `effective_from` is therefore accepted only when the caller names the evidence
 *    that verified it. "Just use the fiscal-year start" is not evidence.
 *  * F6 — two people have no owner-confirmed name. A placeholder (`-`, `unknown`, `N/A`) is not a name.
 *  * F10 — one person has no employee code. A synthesised code is not an identifier, and deriving one from
 *    another code would create a second identity claim.
 *
 * This module is pure and returns a *verdict per gate* rather than throwing on the first problem, because the
 * caller needs every blocker a row has, not just the first. `assert*` wrappers exist for fail-closed callers.
 *
 * **Honest limitation on F5.** Requiring an evidence reference makes the basis of a date *recordable*, not
 * *proven*: this module cannot verify that a reference is authentic, exactly the limitation ADR-011 records for
 * the SSO evidence declaration. It is a contract plus a stored citation a later reviewer can check — not a
 * cryptographic proof. Do not describe a row as "date verified" on the strength of a non-empty string alone.
 *
 * Deliberately NOT a per-row gate here: F4 (UID allocation) is resolved as policy and happens at import time,
 * and F9 (national-ID path) is a global approval rather than a property of one row. The reconciliation CLI
 * reports both separately.
 *
 * No I/O, no clock, no database.
 */

const EMPLOYEE_TYPES = Object.freeze(['university', 'department', 'contract']);

/** Dates that are obviously placeholders rather than evidence. */
const PLACEHOLDER_DATES = Object.freeze(new Set(['1900-01-01', '1970-01-01', '9999-12-31', '0000-00-00']));

/** Tokens that occupy a name column without being a name. Compared after trim + case-fold. */
const PLACEHOLDER_NAMES = Object.freeze(new Set([
  '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', 'tbd', 'ไม่ทราบ', 'ไม่มี', 'ไม่ระบุ',
]));

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GATES = Object.freeze({
  EMAIL: 'F1',
  NAME: 'F2',
  EMPLOYEE_TYPE: 'F3',
  EFFECTIVE_FROM: 'F5',
  EMPLOYEE_CODE: 'F10',
});

const BLOCKERS = Object.freeze({
  EMAIL_MISSING_OR_INVALID: 'EMAIL_MISSING_OR_INVALID',
  NAME_MISSING_OR_UNCONFIRMED: 'NAME_MISSING_OR_UNCONFIRMED',
  EMPLOYEE_TYPE_MISSING_OR_INVALID: 'EMPLOYEE_TYPE_MISSING_OR_INVALID',
  EFFECTIVE_FROM_UNVERIFIED: 'EFFECTIVE_FROM_UNVERIFIED',
  EFFECTIVE_FROM_IS_PLACEHOLDER: 'EFFECTIVE_FROM_IS_PLACEHOLDER',
  EMPLOYEE_CODE_MISSING: 'EMPLOYEE_CODE_MISSING',
});

function text(value) {
  return value == null ? '' : String(value).trim();
}

function isRealIsoDate(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function isPlaceholderName(value) {
  const normalized = text(value).toLowerCase();
  return normalized === '' || PLACEHOLDER_NAMES.has(normalized);
}

/**
 * Assembles the blockers for one prospective import row.
 *
 * @param {object} row
 * @param {string} [row.email]
 * @param {string} [row.firstNameTh]  roster `name`
 * @param {string} [row.lastNameTh]   roster `c_name` — only once the owner confirms the semantics
 * @param {string} [row.employeeType]
 * @param {string} [row.effectiveFrom] ISO date from evidence, never a guess
 * @param {string} [row.effectiveFromEvidenceRef] what verified that date
 * @param {string} [row.employeeCode]
 * @param {string} [row.deviceCode]
 */
function assessImportReadiness(row = {}) {
  const blockers = [];
  const add = (gate, code) => blockers.push(Object.freeze({ gate, code }));

  const email = text(row.email).toLowerCase();
  if (!email || !EMAIL_SHAPE.test(email)) add(GATES.EMAIL, BLOCKERS.EMAIL_MISSING_OR_INVALID);

  if (isPlaceholderName(row.firstNameTh) || isPlaceholderName(row.lastNameTh)) {
    add(GATES.NAME, BLOCKERS.NAME_MISSING_OR_UNCONFIRMED);
  }

  const employeeType = text(row.employeeType).toLowerCase();
  if (!EMPLOYEE_TYPES.includes(employeeType)) {
    add(GATES.EMPLOYEE_TYPE, BLOCKERS.EMPLOYEE_TYPE_MISSING_OR_INVALID);
  }

  // F5: a date is acceptable only when it is real, not a placeholder, and carries its own evidence reference.
  const effectiveFrom = text(row.effectiveFrom);
  const evidenceRef = text(row.effectiveFromEvidenceRef);
  if (!effectiveFrom || !evidenceRef) {
    add(GATES.EFFECTIVE_FROM, BLOCKERS.EFFECTIVE_FROM_UNVERIFIED);
  } else if (PLACEHOLDER_DATES.has(effectiveFrom)) {
    add(GATES.EFFECTIVE_FROM, BLOCKERS.EFFECTIVE_FROM_IS_PLACEHOLDER);
  } else if (!isRealIsoDate(effectiveFrom)) {
    add(GATES.EFFECTIVE_FROM, BLOCKERS.EFFECTIVE_FROM_UNVERIFIED);
  }

  // F10: an employee code must exist. It is never derived from the HIP code or the national ID.
  if (!text(row.employeeCode)) add(GATES.EMPLOYEE_CODE, BLOCKERS.EMPLOYEE_CODE_MISSING);

  const blockedGates = Object.freeze([...new Set(blockers.map((b) => b.gate))]);
  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    blockedGates,
    hasAttendanceCode: text(row.deviceCode) !== '',
  });
}

/** Throws on an F5 failure instead of returning a verdict. */
function assertVerifiedEffectiveFrom({ effectiveFrom, effectiveFromEvidenceRef } = {}) {
  const verdict = assessImportReadiness({
    // Every other gate is satisfied so this assertion can only report F5.
    email: 'fixture@example.test',
    firstNameTh: 'fixture',
    lastNameTh: 'fixture',
    employeeType: 'university',
    employeeCode: 'FIXTURE',
    effectiveFrom,
    effectiveFromEvidenceRef,
  });
  const failure = verdict.blockers.find((b) => b.gate === GATES.EFFECTIVE_FROM);
  if (failure) {
    const error = new Error('effective_from must be a verified, evidence-backed date');
    error.code = failure.code;
    error.gate = GATES.EFFECTIVE_FROM;
    throw error;
  }
  return text(effectiveFrom);
}

/**
 * A national-ID value may only enter the system as an HMAC lookup, never as stored plaintext.
 * Rejects any call that would carry the raw value alongside the digest.
 */
function assertNationalIdLookupOnly({ lookupHmac = null, keyVersion = null, raw = null } = {}) {
  if (raw != null && text(raw) !== '') {
    const error = new Error('a raw national ID must never reach a storage path; use the HMAC lookup only');
    error.code = 'NATIONAL_ID_RAW_REJECTED';
    error.gate = 'F9';
    throw error;
  }
  if (lookupHmac != null && text(keyVersion) === '') {
    const error = new Error('a national-ID lookup digest must carry its key version');
    error.code = 'NATIONAL_ID_KEY_VERSION_MISSING';
    error.gate = 'F9';
    throw error;
  }
  return true;
}

/** Aggregates verdicts into a gate histogram. Counts only — no row reference is returned. */
function summarizeReadiness(verdicts = []) {
  const byGate = {};
  const byCode = {};
  let ready = 0;
  for (const verdict of verdicts) {
    if (verdict.ready) ready += 1;
    for (const gate of verdict.blockedGates) byGate[gate] = (byGate[gate] || 0) + 1;
    for (const blocker of verdict.blockers) byCode[blocker.code] = (byCode[blocker.code] || 0) + 1;
  }
  return Object.freeze({
    assessed: verdicts.length,
    ready,
    blocked: verdicts.length - ready,
    blocked_by_gate: Object.freeze(byGate),
    blocked_by_code: Object.freeze(byCode),
  });
}

module.exports = {
  GATES,
  BLOCKERS,
  EMPLOYEE_TYPES,
  assessImportReadiness,
  assertVerifiedEffectiveFrom,
  assertNationalIdLookupOnly,
  summarizeReadiness,
};
