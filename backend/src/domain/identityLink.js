/**
 * Identity-link domain rules: statuses, the immutable SOURCE ALLOWLIST, and the guards that decide whether a
 * provider subject may be used as identity evidence at all.
 *
 * WHY AN ALLOWLIST (hardening ID-7, audit finding F2)
 * --------------------------------------------------
 * `enrichmentBlocksApproval` only blocks an ambiguous/absent enrichment result when the link's `source` is a
 * KNOWN enrichment source. Before this change a caller could therefore pass an invented source string and
 * create a link whose `ambiguous` outcome would sail past the approval guard - "one missing source, two
 * severities" in reverse: one bad caller, no guard. The list below is now closed: an unknown source is
 * REJECTED AT CREATION, so provenance can no longer be asserted into existence.
 *
 * Adding a new automated source is deliberately a code change with a test (`identityLinkSourcePolicy.test.js`
 * asserts every source used anywhere in `backend/src` is listed here), never a runtime value.
 */

const PROVIDER_MJU_SSO = 'mju_sso';

const LINK_STATUS = {
  CANDIDATE: 'candidate',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
};

/**
 * Every source permitted to create an identity link. FROZEN, and the only accepted set.
 *
 * The strings are chosen to name HOW the link was established, because that is what a reviewer needs:
 *   * `operator_review`             - a human reviewed the evidence and approved it.
 *   * `mju_token_candidate_subject` - the MJU portal token flow; the subject is a CANDIDATE claim, which is
 *                                     why it is not treated as certified.
 *   * `sso_national_id_resolution`  - a first SSO login whose identity was proven by the protected
 *                                     national-ID lookup resolving to the same employee.
 *   * `mju_person_enrich`           - machine enrichment from the MJU Person API (fuzzy NAME lookup; see
 *                                     docs/IDENTITY_INTEGRATION_AUDIT.md). Candidate evidence only.
 *   * `person_api_enrich`           - the same class of machine enrichment under its generic name.
 */
const IDENTITY_LINK_SOURCES = Object.freeze([
  'operator_review',
  'mju_token_candidate_subject',
  'sso_national_id_resolution',
  'mju_person_enrich',
  'person_api_enrich',
]);

const IDENTITY_LINK_SOURCE_SET = new Set(IDENTITY_LINK_SOURCES);

/**
 * The SUBSET of sources whose evidence is machine-generated, and which is therefore subject to the ambiguity
 * guard. A source that is not here is not automatically trusted either - it simply is not machine evidence.
 */
const ENRICHMENT_SOURCES = Object.freeze(['mju_person_enrich', 'person_api_enrich']);

const ENRICHMENT_SOURCE_SET = new Set(ENRICHMENT_SOURCES);

/** Enrichment outcomes that MUST NOT be approvable: each means "the evidence did not resolve to one person". */
const BLOCKED_ENRICHMENT_OUTCOMES = Object.freeze([
  'ambiguous',
  'not_found',
  'timeout',
  'api_error',
  'fallback',
  'firstname_only',
]);

const BLOCKED_ENRICHMENT_OUTCOME_SET = new Set(BLOCKED_ENRICHMENT_OUTCOMES);

/**
 * Confidence values that block approval from an enrichment source: both mean the evidence is not settled.
 * `low` and `ambiguous` are treated identically on purpose - a low-confidence match is not better than an
 * ambiguous one for the purpose of identifying a person.
 */
const BLOCKED_ENRICHMENT_CONFIDENCES = Object.freeze(['ambiguous', 'low']);

const BLOCKED_ENRICHMENT_CONFIDENCE_SET = new Set(BLOCKED_ENRICHMENT_CONFIDENCES);

/* ------------------------------------------------------------------------------------------------
 * Subject guards (hardening ID-6, audit finding F1)
 *
 * These used to live only in the SSO adapter (`services/sso/mjuSubjectAdapter.js`). The link layer accepted
 * an email-shaped subject, which was safe only because that adapter rejected it first and because a
 * candidate cannot authenticate. Any OTHER caller - a future enrichment ingestion path, a script, a test
 * helper - would have bypassed the rule entirely. The predicates are therefore defined ONCE here and
 * imported by the adapter, so the two can no longer drift.
 * ---------------------------------------------------------------------------------------------- */

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when a value looks like an e-mail address. E-mail is never identity evidence. */
function isEmailShaped(value) {
  return EMAIL_LIKE.test(String(value ?? ''));
}

/** True for the callback `ac` marker itself (case-insensitive on the exact marker, `AC`). */
function isCallbackAcLike(value) {
  return value === 'ac' || value === 'AC';
}

/** Reasons a provider subject may not be used as identity evidence. */
const SUBJECT_REJECTION = Object.freeze({
  REQUIRED: 'SUBJECT_REQUIRED',
  MALFORMED: 'SUBJECT_MALFORMED',
  TOO_LONG: 'SUBJECT_TOO_LONG',
  CALLBACK_AC: 'SUBJECT_IS_CALLBACK_AC',
  EMAIL_LIKE: 'SUBJECT_IS_EMAIL_LIKE',
});

/**
 * Longest provider subject accepted, in characters. A subject is an opaque provider token, never free text,
 * so an unbounded value is a data-quality and storage problem rather than a legitimate input.
 */
const MAX_SUBJECT_LENGTH = 255;

/**
 * The single decision point for "may this string be a provider subject?".
 *
 * Returns a rejection code, or null when the subject is acceptable. The subject is trimmed first so that
 * `' ac '` and `'  a@b.co '` cannot slip through on whitespace.
 *
 * Note what this deliberately does NOT do: it does not decide whether the subject is a VERIFIED provider
 * subject. That is a provider-contract question owned by `mjuSubjectAdapter`. This function only enforces
 * the structural prohibitions that hold for every caller (malformed, oversized, e-mail, callback `ac`) plus
 * non-emptiness.
 */
function rejectionCodeForProviderSubject(providerSubject) {
  // Only a string or a number can be an opaque subject. An object, array, boolean or symbol is a caller bug
  // (or an injection attempt) and must not be stringified into a stored identity claim.
  if (typeof providerSubject !== 'string' && typeof providerSubject !== 'number') {
    return SUBJECT_REJECTION.MALFORMED;
  }
  if (typeof providerSubject === 'number' && !Number.isFinite(providerSubject)) {
    return SUBJECT_REJECTION.MALFORMED;
  }
  const value = String(providerSubject).trim();
  if (!value) return SUBJECT_REJECTION.REQUIRED;
  if (value.length > MAX_SUBJECT_LENGTH) return SUBJECT_REJECTION.TOO_LONG;
  if (isCallbackAcLike(value)) return SUBJECT_REJECTION.CALLBACK_AC;
  if (isEmailShaped(value)) return SUBJECT_REJECTION.EMAIL_LIKE;
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Source validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * True only for a source that EXACTLY equals an allowlist entry. Unknown, blank, mistyped or
 * whitespace-padded sources are not "close enough".
 *
 * Deliberately strict, with no trimming: a `source` value comes from our own code, never from a user, so a
 * stray space is a bug to surface rather than to normalise away. Strict equality also guarantees that the
 * value STORED is always a value that was VALIDATED - a lenient check that stored the untrimmed original
 * would leave a row whose source is not in the allowlist it was checked against.
 */
function isKnownSource(source) {
  return typeof source === 'string' && IDENTITY_LINK_SOURCE_SET.has(source);
}

/**
 * True when a source's evidence is machine-generated and therefore subject to the ambiguity guard.
 *
 * Deliberately LENIENT (trimmed), the opposite of `isKnownSource`, and the asymmetry is the point:
 * validation should be strict, while a guard should be generous. A legacy or hand-written row whose source
 * is `'mju_person_enrich '` is still machine evidence and must still be blocked at approval.
 */
function isEnrichmentSource(source) {
  return ENRICHMENT_SOURCE_SET.has(String(source ?? '').trim());
}

function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function isAuthenticatableStatus(status) {
  return status === LINK_STATUS.APPROVED;
}

/**
 * Whether an approval must be refused for this link.
 *
 * Scope note: the guard only applies to sources in `ENRICHMENT_SOURCES`. That is intentional - an operator
 * review is human evidence and a human may approve an ambiguous match after looking at it. The risk that
 * guard-scoping created was a caller INVENTING a source to escape it; `isKnownSource` closes that, because
 * an unknown source can no longer be written at all (see `identityResolutionService.createCandidate`).
 */
function enrichmentBlocksApproval(link) {
  if (!isEnrichmentSource(link?.source)) return false;
  if (BLOCKED_ENRICHMENT_OUTCOME_SET.has(link.enrichmentOutcome)) return true;
  if (BLOCKED_ENRICHMENT_CONFIDENCE_SET.has(link.confidence)) return true;
  return false;
}

module.exports = {
  PROVIDER_MJU_SSO,
  LINK_STATUS,
  IDENTITY_LINK_SOURCES,
  ENRICHMENT_SOURCES,
  BLOCKED_ENRICHMENT_OUTCOMES,
  BLOCKED_ENRICHMENT_CONFIDENCES,
  EMAIL_LIKE,
  SUBJECT_REJECTION,
  MAX_SUBJECT_LENGTH,
  isEmailShaped,
  isCallbackAcLike,
  rejectionCodeForProviderSubject,
  isKnownSource,
  isEnrichmentSource,
  normalizeEmail,
  isAuthenticatableStatus,
  enrichmentBlocksApproval,
};
