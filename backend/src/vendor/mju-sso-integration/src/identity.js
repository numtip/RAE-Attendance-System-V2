import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { CONTRACT_STATUS } from './contract.js';

/**
 * Identity normalization.
 *
 * The provider's JSON is an ASSERTION, not an authenticated identity. This module
 * reduces it to the smallest possible statement — a candidate provider subject —
 * and refuses everything else. In particular:
 *
 *   - a non-empty `citizenID` is a schema check and NEVER an authorization
 *   - `ac` is never a subject
 *   - an e-mail, a name or a national id is never a subject
 *   - an ambiguous claim (two claims that disagree) fails closed
 *
 * A caller must still resolve the subject to an APPROVED local link before a
 * session exists. `status: 'candidate'` means exactly that: unresolved.
 */

/** Claims that are structurally usable as a subject handle. National id is deliberately absent. */
export const CANDIDATE_SUBJECT_CLAIMS = Object.freeze(['humanID', 'personID']);

/**
 * Claims a deployment may select **only** against a promoted contract item.
 *
 * `citizenID` is here because the MJU SSO administrator named it as the subject in a written
 * answer dated 2026-11-04 (register S13). Naming it is not the same as being allowed to use it:
 * ADR-003 requires two reviewers to promote C-08, so this module accepts the claim only when
 * `contractStatus` is `VERIFIED`. A caller that passes it too early gets a refusal, not a
 * subject.
 */
export const CONFIRMABLE_SUBJECT_CLAIMS = Object.freeze(['citizenID']);

/** Claims whose value is confidential and must never be persisted as-is. */
export const CONFIDENTIAL_SUBJECT_CLAIMS = Object.freeze(['citizenID']);

/** Profile fields an application may read. Everything else is dropped on arrival. */
export const PROFILE_ALLOWLIST = Object.freeze([
  'titleName',
  'firstName',
  'lastName',
  'e_mail',
  'section',
  'division',
  'faculty',
  'course',
]);

/** Values that must never be accepted as a subject, even if a claim carries them. */
const IDENTITY_SHAPED_FIELDS = Object.freeze([
  'name',
  'e_mail',
  'email',
  'firstName',
  'lastName',
  'firstNameEn',
  'lastNameEn',
  'titleName',
  'titleNameEn',
]);

const SUBJECT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * @param {unknown} document provider JSON
 * @param {{
 *   ac?: string,
 *   subjectClaim?: string,
 *   subjectClaims?: readonly string[],
 *   includeProfile?: boolean,
 *   contractStatus?: string,
 * }} [options]
 * @returns {{
 *   provider: 'mju-sso',
 *   status: 'candidate',
 *   subject: string,
 *   subjectClaim: string,
 *   citizenIdPresent: boolean,
 *   profile?: Record<string, string>
 * }}
 */
export function normalizeIdentityAssertion(document, options = {}) {
  const {
    ac,
    subjectClaim,
    subjectClaims,
    includeProfile = false,
    contractStatus = CONTRACT_STATUS.UNKNOWN,
    lawfulBasisApproved = false,
  } = options;

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SsoError(SSO_ERROR_CODES.RESPONSE_INVALID, {
      status: 502,
      message: 'The provider identity document is not a JSON object',
    });
  }

  // Schema completeness only. This value never grants anything.
  const citizenId = text(document.citizenID);
  if (citizenId === '') {
    throw new SsoError(SSO_ERROR_CODES.RESPONSE_INVALID, {
      status: 502,
      message: 'The provider identity document is incomplete',
    });
  }

  // An explicit claim is the supported deployment shape once MJU names the subject (C-08).
  // Without one, every present candidate claim must AGREE: the vendor sample carries
  // humanID and personID with different values, so the unscoped default fails closed. That is
  // deliberate — the alternative is guessing which field is the subject.
  let candidates;
  if (subjectClaim !== undefined) {
    const selectable = [...CANDIDATE_SUBJECT_CLAIMS, ...CONFIRMABLE_SUBJECT_CLAIMS];
    if (!selectable.includes(subjectClaim)) {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 503,
        message: `subjectClaim must be one of: ${selectable.join(', ')}`,
      });
    }
    candidates = [subjectClaim];
  } else {
    candidates = subjectClaims ?? CANDIDATE_SUBJECT_CLAIMS;
  }

  // A confirmable claim (citizenID) is usable only once the contract promotes it. This is the
  // runtime half of C-08: the capability exists, the gate decides whether it may be exercised.
  const confirmable = candidates.filter((claim) => CONFIRMABLE_SUBJECT_CLAIMS.includes(claim));
  if (confirmable.length > 0 && contractStatus !== CONTRACT_STATUS.VERIFIED) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 503,
      message: `subject claim ${confirmable.join(', ')} requires a VERIFIED contract item (C-08)`,
      details: { claims: confirmable, contractStatus },
    });
  }

  // Two independent gates, deliberately not one. C-08 answers "which field identifies the person";
  // C-14 answers "may we receive it at all". Collapsing them would mean that promoting the contract
  // silently authorised processing a national id — so a confidential claim needs both, and the
  // lawful-basis flag defaults to false.
  if (confirmable.length > 0 && lawfulBasisApproved !== true) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 503,
      message: `subject claim ${confirmable.join(', ')} requires an approved lawful basis (C-14)`,
      details: { claims: confirmable, lawfulBasisApproved: false },
    });
  }

  const present = candidates
    .map((claim) => ({ claim, value: text(document[claim]) }))
    .filter((entry) => entry.value !== '');

  if (present.length === 0) {
    throw new SsoError(SSO_ERROR_CODES.SUBJECT_MISSING, {
      status: 403,
      message: 'The provider did not return a usable subject',
    });
  }
  const distinct = new Set(present.map((entry) => entry.value));
  if (distinct.size > 1) {
    throw new SsoError(SSO_ERROR_CODES.SUBJECT_AMBIGUOUS, {
      status: 403,
      message: 'The provider subject claims disagree',
    });
  }

  const subject = present[0].value;
  const resolvedClaim = present[0].claim;

  assertSubjectIsNotIdentityMaterial({ subject, ac, citizenId, document, claim: resolvedClaim });

  const result = {
    provider: /** @type {const} */ ('mju-sso'),
    // A candidate is never promoted here. Promotion requires provider-written certification
    // (contract C-08/C-13) plus an approved local link; neither can be inferred from JSON.
    status: /** @type {const} */ ('candidate'),
    subject,
    subjectClaim: resolvedClaim,
    citizenIdPresent: true,
    subjectCertifiedByProvider: contractStatus === CONTRACT_STATUS.VERIFIED,
    // Confidential claims must be transformed (application-scoped HMAC) before storage; a
    // caller that ignores this flag would persist a national id.
    subjectIsConfidential: CONFIDENTIAL_SUBJECT_CLAIMS.includes(resolvedClaim),
  };

  if (includeProfile) {
    result.profile = pickProfile(document);
  }
  return result;
}

function assertSubjectIsNotIdentityMaterial({ subject, ac, citizenId, document, claim }) {
  const invalid = () => {
    throw new SsoError(SSO_ERROR_CODES.SUBJECT_INVALID, {
      status: 403,
      message: 'The provider subject is not a usable identity handle',
    });
  };

  if (!SUBJECT_PATTERN.test(subject)) invalid();
  if (typeof ac === 'string' && ac !== '' && subject === ac) invalid();

  // The one sanctioned exception: when the selected claim IS the citizen id (C-08, promoted by
  // two reviewers), the national id is the subject. It still may not arrive through any other
  // claim, and the caller must derive an application-scoped HMAC before storing it.
  if (CONFIDENTIAL_SUBJECT_CLAIMS.includes(claim)) {
    if (subject !== citizenId) invalid();
    if (EMAIL_SHAPED.test(subject)) invalid();
    return;
  }

  if (subject === citizenId) invalid();

  const subjectDigits = subject.replace(/\D/g, '');
  if (subjectDigits !== '' && subjectDigits === citizenId.replace(/\D/g, '')) invalid();

  if (EMAIL_SHAPED.test(subject)) invalid();
  for (const field of IDENTITY_SHAPED_FIELDS) {
    const other = text(document[field]);
    if (other !== '' && other === subject) invalid();
  }
}

/** Copy only allowlisted profile fields, as trimmed strings. */
export function pickProfile(document) {
  /** @type {Record<string, string>} */
  const profile = {};
  for (const field of PROFILE_ALLOWLIST) {
    const value = text(document[field]);
    if (value !== '') profile[field] = value;
  }
  return profile;
}

export const _internals = Object.freeze({ SUBJECT_PATTERN, EMAIL_SHAPED });
