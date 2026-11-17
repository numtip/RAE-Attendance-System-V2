/**
 * Provider-independent identity mapping.
 *
 * This module never decides what the provider sends; that is the contract's job and it is still
 * UNKNOWN. What it decides is **which local facts may be used to bind a provider assertion to a
 * local employee**, for any application, and it refuses the shortcuts that silently authenticate
 * the wrong person.
 *
 * Every branch fails closed. The decision function does not treat a *missing* employee, an
 * *unknown* status, an unprovenanced approval or an unparsable date as "nothing to check" — each
 * one is a deny with its own code, because "no data" and "no problem" are the same thing only to
 * a fail-open design.
 */
import { createHash, createHmac } from 'node:crypto';

import { SsoError, SSO_ERROR_CODES } from './errors.js';

/** Link lifecycle. Only `approved` may authorise, and only while current, provenanced and unique. */
export const LINK_STATUSES = Object.freeze(['candidate', 'pending', 'approved', 'revoked']);

/** Local employment statuses this module understands. Anything else is refused, never guessed. */
export const EMPLOYEE_STATUSES = Object.freeze([
  'active',
  'inactive',
  'suspended',
  'disabled',
  'retired',
]);

/**
 * Employee identifier namespaces, in trust order.
 *
 * `EMPLOYEE` is the local, application-owned key (the roster's `ID HIP` is one source of it).
 * `REFERENCE_ONLY` namespaces may be shown to a human reviewer and used for manual lookup, and
 * must never be stored as, or compared as, an identity key on their own.
 *
 * The national id is deliberately **not** a namespace: while C-14 is BLOCKED the value is not received
 * at all, so there is nothing to look up by.
 */
export const IDENTIFIER_NAMESPACES = Object.freeze({
  EMPLOYEE: 'ID_HIP',
  REFERENCE_ONLY: Object.freeze(['MJU_EMAIL']),
});

/**
 * Fields that must never appear on a mapping record or on a reference row.
 *
 * The national id is listed in every spelling because hashing it is **not** approved: contract
 * item C-14 (lawful basis for receiving a Thai citizen id) is BLOCKED, so the value must not be
 * received, hashed or stored at all. A row that carries one is refused loudly, so a whole-file
 * import stops instead of quietly keeping a digest nobody authorised.
 */
const FORBIDDEN_PERSISTED_FIELDS = Object.freeze([
  'ac',
  'citizenID',
  'citizenId',
  'citizenid',
  'citizenIdSha256',
  'citizen_id',
  'citizen_id_sha256',
  'idCard',
  'id_card',
  'ID card',
  'id-card',
  'nationalId',
  'national_id',
  'password',
  'sessionToken',
  'accessToken',
  'id_token',
  'refresh_token',
]);

/**
 * Claims whose value is confidential identity material.
 *
 * `citizenID` became the confirmed subject on 2026-11-04 (register S13). It is a national id, so
 * the rules are stricter than for an opaque handle: the value is never stored, never logged and
 * never used raw as a link key — it is transformed into an application-scoped HMAC first.
 */
export const CONFIDENTIAL_SUBJECT_CLAIMS = Object.freeze(['citizenID']);

/** A derived subject key: 32 bytes of HMAC-SHA256, hex encoded. */
const SUBJECT_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Minimum HMAC key length. 32 bytes matches the digest size; a short key is a password. */
export const SUBJECT_KEY_MIN_BYTES = 32;

/** A local employee key: digits, 1-12 of them. The roster's format, not the provider's. */
const EMPLOYEE_KEY_PATTERN = /^[0-9]{1,12}$/;
/** Opaque provider subject: the same shape src/identity.js accepts. */
const SUBJECT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function refuse(code, message, details) {
  throw new SsoError(code, { message, details });
}

/** Strict extended-format ISO-8601 date-time. A timezone designator is mandatory. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;
/** ISO-8601 maximum positive offset. +14:00 exactly; +14:30 is not a real zone. */
const MAX_OFFSET_HOURS = 14;

/** @param {number} year */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Days in a month, leap-year aware.
 *
 * @param {number} year
 * @param {number} month 1-12
 * @returns {number}
 */
function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse an instant strictly.
 *
 * `new Date()` is far too permissive for a security decision, and every one of these is accepted
 * and silently rewritten:
 *
 *   - `2026-02-30T00:00:00Z` → `2026-03-02` (calendar overflow)
 *   - `2025-02-29T00:00:00Z` → `2025-03-01` (non-leap year)
 *   - `2026-01-01T24:00:00Z` → `2026-01-02` (hour overflow)
 *   - `2026-01-01T00:00:00`   → parsed as **local** time, so the answer depends on the host's zone
 *   - `2026-01-01T00:00:00+14:30` → accepted although no zone is +14:30
 *   - `Feb 30 2026`, `2026-01-01` → non-ISO forms accepted
 *
 * A rewritten instant is worse than a rejected one: a link meant to expire on 2026-02-30 would
 * quietly expire on 2026-03-02 instead. So the shape is checked first, every field is then checked
 * against the real calendar, and anything unparsable returns `null` — which forces the caller to
 * deny.
 *
 * @param {unknown} value
 * @returns {Date|null}
 */
function parseInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const match = ISO_INSTANT.exec(raw);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // 24:00-24:59 is an ISO "end of day" form that normalises into the next day, so it is refused.
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > MAX_OFFSET_HOURS) return null;
    if (offsetMins > 59) return null;
    if (offsetHours === MAX_OFFSET_HOURS && offsetMins !== 0) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  const fractionMicros = fractionText ? Number(fractionText.padEnd(3, '0').slice(0, 3)) : 0;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, fractionMicros);
  if (Number.isNaN(utcMs)) return null;
  const instant = new Date(utcMs - offsetMinutes * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Normalise a local employee key. Rejects an e-mail or a national id pasted into the field, which
 * is how a reference list quietly becomes an identity provider.
 *
 * @param {unknown} value
 * @returns {string} canonical digits
 */
export function normalizeEmployeeKey(value) {
  const raw = text(value);
  if (!raw) refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, 'employee key is empty');
  if (EMAIL_SHAPED.test(raw)) {
    refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, 'an e-mail address is never an employee key');
  }
  if (!EMPLOYEE_KEY_PATTERN.test(raw)) {
    refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, 'employee key must be 1-12 digits', {
      received: raw.length,
    });
  }
  return raw.replace(/^0+(?=\d)/, '');
}

/**
 * Validate one roster row for use as REFERENCE DATA.
 *
 * Returns a record that is safe to store: the employee key, display fields, a normalised
 * employment status and the `active` flag derived from it. The national id is never hashed and
 * never kept — a row carrying one is refused (see `FORBIDDEN_PERSISTED_FIELDS`).
 *
 * @param {object} row
 * @returns {{employeeKey: string, namespaces: object, display: object, status: string, active: boolean, employeeType: string}}
 */
export function validateEmployeeReference(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, 'roster row must be an object');
  }
  for (const field of Object.keys(row)) {
    if (FORBIDDEN_PERSISTED_FIELDS.includes(field)) {
      refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, `roster row carries a forbidden field: ${field}`, {
        field,
      });
    }
  }

  const employeeKey = normalizeEmployeeKey(row.employeeKey ?? row['ID HIP'] ?? row.employee_id);
  const email = text(row.email ?? row['E-MAIL']).toLowerCase();
  const status = text(row.status).toLowerCase();

  // An unknown or missing status is refused rather than defaulted to `active`. Defaulting is
  // exactly how a leaver keeps signing in for another year.
  if (!EMPLOYEE_STATUSES.includes(status)) {
    refuse(SSO_ERROR_CODES.IDENTITY_EMPLOYEE_UNKNOWN, 'employee status is missing or unknown', {
      accepted: [...EMPLOYEE_STATUSES],
    });
  }

  const firstName = row.name ?? row.firstName ?? null;
  const lastName = row.cName ?? row.lastName ?? null;
  for (const [field, value] of [['firstName', firstName], ['lastName', lastName]]) {
    if (value !== null && typeof value !== 'string') {
      refuse(SSO_ERROR_CODES.IDENTITY_KEY_INVALID, `roster display field is not text: ${field}`, {
        field,
      });
    }
  }

  return {
    employeeKey,
    namespaces: {
      [IDENTIFIER_NAMESPACES.EMPLOYEE]: employeeKey,
      ...(email ? { MJU_EMAIL: email } : {}),
    },
    display: {
      firstName: typeof firstName === 'string' ? firstName.trim() || null : null,
      lastName: typeof lastName === 'string' ? lastName.trim() || null : null,
    },
    status,
    active: status === 'active',
    employeeType: text(row.employeeType ?? row['employee type']) || 'unknown',
  };
}

/**
 * Whether a claim carries confidential identity material.
 *
 * @param {unknown} claim
 * @returns {boolean}
 */
export function isConfidentialClaim(claim) {
  return CONFIDENTIAL_SUBJECT_CLAIMS.includes(text(claim));
}

/**
 * Derive the storable key for a confidential subject.
 *
 * A plain SHA-256 of a 13-digit national id is not protection: the whole space is enumerable, so
 * anyone holding the digest can recover the id. An HMAC with a per-application secret cannot be
 * reversed without the key, and keying it per application means two applications cannot correlate
 * the same person by comparing digests.
 *
 * The `appId` and `provider` are inside the HMAC *and* the key is per application, so a key that
 * leaks for one application says nothing about another.
 *
 * @param {{appId: string, provider: string, subject: unknown, hmacKey: string|Buffer}} input
 * @returns {string} 64-character hex digest
 */
export function deriveSubjectKey({ appId, provider, subject, hmacKey } = {}) {
  const app = text(appId);
  const prov = text(provider);
  const raw = text(subject);
  if (!app) refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'appId is required to derive a subject key');
  if (!prov) refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'provider is required to derive a subject key');
  if (!raw) refuse(SSO_ERROR_CODES.SUBJECT_MISSING, 'subject value is required');
  if (!SUBJECT_PATTERN.test(raw)) {
    refuse(SSO_ERROR_CODES.SUBJECT_INVALID, 'subject value has an unusable shape');
  }

  const key = typeof hmacKey === 'string' ? Buffer.from(hmacKey, 'utf8') : hmacKey;
  if (!Buffer.isBuffer(key) || key.length < SUBJECT_KEY_MIN_BYTES) {
    refuse(SSO_ERROR_CODES.CONFIG_INVALID, `hmacKey must be at least ${SUBJECT_KEY_MIN_BYTES} bytes`, {
      received: Buffer.isBuffer(key) ? key.length : 0,
    });
  }

  return createHmac('sha256', key).update(['v1', app, prov, raw].join('\u0000'), 'utf8').digest('hex');
}

/**
 * Storage guard for a link record.
 *
 * A link for a confidential claim must carry `subjectKey` and must not carry `subject`. This is
 * the check a migration runs over existing rows, so a national id that reached the database
 * before the rule existed is found rather than inherited silently.
 *
 * @param {object} link
 * @returns {{claimConfidential: boolean, hasRawSubject: boolean, hasSubjectKey: boolean, safe: boolean}}
 */
export function validateLinkRecord(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) {
    refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'link record must be an object');
  }
  const claimConfidential = isConfidentialClaim(link.subjectClaim);
  const hasRawSubject = text(link.subject) !== '';
  const hasSubjectKey = SUBJECT_KEY_PATTERN.test(text(link.subjectKey));
  if (claimConfidential && hasRawSubject) {
    return { claimConfidential, hasRawSubject, hasSubjectKey, safe: false };
  }
  if (!claimConfidential && !hasRawSubject) {
    return { claimConfidential, hasRawSubject, hasSubjectKey, safe: false };
  }
  if (claimConfidential && !hasSubjectKey) {
    return { claimConfidential, hasRawSubject, hasSubjectKey, safe: false };
  }
  return { claimConfidential, hasRawSubject, hasSubjectKey, safe: true };
}

/**
 * Deterministic link identity. One digest per (application, provider, claim, subject), so the same
 * person can hold separate links in separate applications without colliding.
 *
 * For a confidential claim the *derived* key is the identity material, never the raw value, so a
 * link id can be computed and stored without the national id touching the database.
 *
 * @param {{appId: string, provider: string, subjectClaim: string, subject?: string, subjectKey?: string}} key
 * @returns {string} hex digest
 */
export function identityLinkId({ appId, provider, subjectClaim, subject, subjectKey } = {}) {
  const app = text(appId);
  const prov = text(provider);
  const claim = text(subjectClaim);
  if (!app) refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'appId is required');
  if (!prov) refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'provider is required');
  if (!claim) refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'subjectClaim is required');

  let material;
  if (isConfidentialClaim(claim)) {
    const derived = text(subjectKey);
    if (!SUBJECT_KEY_PATTERN.test(derived)) {
      refuse(
        SSO_ERROR_CODES.IDENTITY_LINK_INVALID,
        'a confidential claim needs a derived subjectKey; the raw value is never used',
      );
    }
    material = derived;
  } else {
    const sub = text(subject);
    if (!SUBJECT_PATTERN.test(sub)) {
      refuse(SSO_ERROR_CODES.SUBJECT_INVALID, 'provider subject has an unusable shape');
    }
    material = sub;
  }
  return sha256([app, prov, claim, material].join('\u0000'));
}

/**
 * Decide whether a provider assertion may become a session, for one application.
 *
 * Denies, in this order: a malformed request · no link · a duplicate link record · a revoked, or
 * non-approved, or unknown status · an approval without provenance · an unparsable or
 * out-of-range validity window · a missing employee · a malformed employee key · a link naming a
 * different employee · an unknown employment status · an employee who is not active · a second
 * approved link for the same employee or the same subject.
 *
 * @param {{
 *   request: {appId: string, provider: string, subjectClaim: string, subject: string},
 *   links?: Array<object>,
 *   employee?: object|null,
 *   now?: Date|string,
 * }} input
 * @returns {{decision: 'ALLOW'|'DENY', employeeKey?: string, reason?: string, detail?: string, linkId?: string}}
 */
export function evaluateIdentityLink({ request, links = [], employee = null, now = new Date() } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return deny(SSO_ERROR_CODES.IDENTITY_UNLINKED, 'request is missing');
  }
  const appId = text(request.appId);
  const provider = text(request.provider);
  const subjectClaim = text(request.subjectClaim);
  if (!appId || !provider || !subjectClaim) {
    return deny(SSO_ERROR_CODES.IDENTITY_UNLINKED, 'request is incomplete');
  }
  if (!Array.isArray(links)) {
    refuse(SSO_ERROR_CODES.IDENTITY_LINK_INVALID, 'links must be an array');
  }

  // A confidential claim (citizenID) is matched on its derived key. Passing the raw value here is
  // refused rather than accepted-and-hashed, so a caller cannot skip the derivation by accident and
  // quietly persist a national id through the link table.
  const claimConfidential = isConfidentialClaim(subjectClaim);
  const rawSubject = text(request.subject);
  const subjectKey = text(request.subjectKey);
  let material;
  if (claimConfidential) {
    if (rawSubject !== '') {
      return deny(
        SSO_ERROR_CODES.SUBJECT_INVALID,
        'confidential claim: pass the derived subjectKey, never the raw subject',
      );
    }
    if (!SUBJECT_KEY_PATTERN.test(subjectKey)) {
      return deny(SSO_ERROR_CODES.SUBJECT_INVALID, 'confidential claim requires a 64-hex subjectKey');
    }
    material = subjectKey;
  } else {
    if (!SUBJECT_PATTERN.test(rawSubject)) {
      return deny(SSO_ERROR_CODES.IDENTITY_UNLINKED, 'request is incomplete');
    }
    material = rawSubject;
  }

  const at = parseInstant(now);
  if (!at) return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'evaluation instant is unparsable');

  const matches = links.filter(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      text(candidate.appId) === appId &&
      text(candidate.provider) === provider &&
      text(candidate.subjectClaim) === subjectClaim &&
      (claimConfidential
        ? text(candidate.subjectKey) === material
        : text(candidate.subject) === material),
  );
  if (matches.length === 0) {
    return deny(SSO_ERROR_CODES.IDENTITY_UNLINKED, 'no link for this subject');
  }
  // Two records for one key make the answer row-order dependent, so both are untrusted.
  if (matches.length > 1) {
    return deny(SSO_ERROR_CODES.IDENTITY_CONFLICT, 'duplicate link records for this subject');
  }

  const link = matches[0];
  const linkId = identityLinkId({
    appId,
    provider,
    subjectClaim,
    ...(claimConfidential ? { subjectKey: material } : { subject: material }),
  });
  const status = text(link.status);

  if (!LINK_STATUSES.includes(status)) {
    return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'unknown link status', linkId);
  }
  if (status === 'revoked') return deny(SSO_ERROR_CODES.IDENTITY_DISABLED, 'link revoked', linkId);
  if (status !== 'approved') {
    return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, `link is ${status}`, linkId);
  }

  // Approval without a named human, a valid instant and an evidence pointer is an unsourced
  // claim. The schema says so too; this runtime check is what actually stops it.
  const approvedBy = text(link.approvedBy);
  const approvedAt = parseInstant(link.approvedAt);
  const evidenceRef = text(link.evidenceRef);
  if (!approvedBy || !approvedAt || !evidenceRef) {
    return deny(
      SSO_ERROR_CODES.IDENTITY_PROVENANCE_INVALID,
      'approved link is missing approval provenance',
      linkId,
    );
  }

  if (text(link.validFrom) !== '') {
    const from = parseInstant(link.validFrom);
    if (!from) return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'validFrom is unparsable', linkId);
    if (at < from) return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'link is not yet valid', linkId);
  }
  if (text(link.validTo) !== '') {
    const to = parseInstant(link.validTo);
    if (!to) return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'validTo is unparsable', linkId);
    if (at > to) return deny(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, 'link has expired', linkId);
  }

  // The employee side is mandatory: a missing record is a deny, never a pass.
  if (!employee || typeof employee !== 'object' || Array.isArray(employee)) {
    return deny(SSO_ERROR_CODES.IDENTITY_EMPLOYEE_UNKNOWN, 'employee record is missing', linkId);
  }
  const employeeKey = text(employee.employeeKey);
  if (!EMPLOYEE_KEY_PATTERN.test(employeeKey)) {
    return deny(SSO_ERROR_CODES.IDENTITY_EMPLOYEE_UNKNOWN, 'employee key is malformed', linkId);
  }
  if (text(link.employeeKey) !== employeeKey) {
    return deny(SSO_ERROR_CODES.IDENTITY_CONFLICT, 'link and employee disagree', linkId);
  }
  const employeeStatus = text(employee.status).toLowerCase();
  if (!EMPLOYEE_STATUSES.includes(employeeStatus)) {
    return deny(SSO_ERROR_CODES.IDENTITY_EMPLOYEE_UNKNOWN, 'employee status is unknown', linkId);
  }
  // `active` must be the boolean derived by the validator; a missing or non-boolean flag cannot pass.
  if (employee.active !== true || employeeStatus !== 'active') {
    return deny(SSO_ERROR_CODES.IDENTITY_DISABLED, 'employee is not active', linkId);
  }

  // Uniqueness inside one application: a second approved link to the same employee, or the same
  // subject approved to a different employee, makes the result order-dependent.
  const rivals = links.filter(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      candidate !== link &&
      text(candidate.status) === 'approved' &&
      text(candidate.appId) === appId &&
      (text(candidate.employeeKey) === employeeKey ||
        (claimConfidential
          ? text(candidate.subjectKey) === material
          : text(candidate.subject) === material)),
  );
  if (rivals.length > 0) {
    return deny(SSO_ERROR_CODES.IDENTITY_CONFLICT, 'another approved link exists for this employee', linkId);
  }

  return { decision: 'ALLOW', employeeKey, linkId };
}

function deny(reason, detail, linkId) {
  return { decision: 'DENY', reason, detail, ...(linkId ? { linkId } : {}) };
}

/**
 * Whether a link may be created without a human decision.
 *
 * Always false. A roster row proves an employee exists; it never proves that this provider subject
 * is that employee. The function exists so callers can ask the question in code instead of writing
 * the shortcut inline.
 *
 * @returns {{allowed: false, reason: string, requires: readonly string[]}}
 */
export function canAutoLink() {
  return {
    allowed: false,
    reason: 'SSO_AUTO_LINK_FORBIDDEN',
    requires: Object.freeze([
      'a written provider answer naming the authoritative subject claim',
      'an approved link created by a human with a recorded evidence reference',
      'two reviewers, per promotionRequires',
    ]),
  };
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
