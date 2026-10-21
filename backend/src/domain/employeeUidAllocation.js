/**
 * F4 — owner-approved employee identity policy (owner approval 2026-10-21).
 *
 *   UUIDv4 / Immutable / One Person One UID / No Automatic Identity Merge.
 *
 * The invariants this module exists to enforce, and why each one is code instead of a comment:
 *
 *  1. **UUIDv4, allocated once.** `employee_uid` is a version-4 UUID generated for a verified *new* person.
 *     `002_employees.sql` declares it `VARCHAR(36) NOT NULL` with no default and no CHECK, so nothing in the
 *     database prevents a non-UUID or a hand-built string from becoming a primary key. `allocateEmployeeUid`
 *     is the only sanctioned source, and it validates the shape it hands back.
 *  2. **Immutable.** A re-import reuses the stored UID. `assertEmployeeUidUnchanged` fails closed when a new
 *     UID is proposed for an existing person. Re-keying is not a supported operation: `daily_attendance` and
 *     `monthly_summary` declare **no** foreign key to `employees`, so a UID change could silently orphan
 *     attendance history instead of being blocked by the database.
 *  3. **Never derived.** The UID is not a function of the HIP/facescan code, national ID, employee code,
 *     email or name. `uuidFactory` is called with zero arguments, and a test asserts that.
 *  4. **Identity is decided only by identifier ownership.** A name or email match never creates, merges or
 *     re-points an identity. Those attributes can only corroborate a match an identifier already proved, or
 *     raise a warning when they disagree.
 *  5. **No automatic merge.** One identifier value owned by two UIDs, two strong identifiers pointing at two
 *     UIDs, or two candidate rows claiming the same identifier are all CONFLICT. Handed to a human; nothing
 *     is merged, deleted or re-pointed.
 *
 * ## National IDs are lookup keys, never raw keys
 *
 * The database never stores a raw national ID: `employee_identifier.id_value` holds an HMAC-SHA-256 lookup for
 * `national_id` (migration 015), and the repository returns `null` for the id value. A raw 13-digit value can
 * therefore never match a stored row, so using one as an ownership key would silently classify a returning
 * person as new and give them a **second UID**.
 *
 * The rule here is therefore explicit:
 *   * existing rows are matched on `national_id_lookup` (the stored digest), and a raw `national_id` supplied
 *     for an existing row is **ignored** as a match key;
 *   * a candidate's raw `national_id` is converted with the injected `nationalIdLookup` function, which is the
 *     same contract the importer must use;
 *   * if a candidate carries a national ID and no lookup function is available, ownership cannot be proven, so
 *     the candidate is **QUARANTINE** (`NATIONAL_ID_LOOKUP_UNAVAILABLE`) rather than CREATE. Failing closed is
 *     the only safe answer: the alternative is a duplicate identity for a person who already exists.
 *
 * This module is pure: no I/O, no clock, no database, no environment, no crypto key access. It returns a
 * *plan*; it never writes. The caller owns transactions and idempotency.
 */
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');

const POLICY = Object.freeze({
  id: 'F4',
  version: '1.1',
  approved_on: '2026-10-21',
  uid_scheme: 'uuid_v4',
  immutable: true,
  one_person_one_uid: true,
  automatic_merge: false,
  identity_key: 'identifier_ownership_only',
  national_id_key: 'lookup_digest_only',
});

/** Version 4 and RFC 4122 variant. Deliberately stricter than a generic UUID shape. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The four identifier kinds `employee_identifier.id_type` accepts after migration 013. */
const IDENTIFIER_TYPES = Object.freeze(['employee_id', 'personnel_id', 'facescan_id', 'national_id']);

/** Kinds that may act as an ownership key. `national_id` is absent on purpose — see the header. */
const MATCH_KEY_TYPES = Object.freeze(['employee_id', 'personnel_id', 'facescan_id', 'national_id_lookup']);

/** An HMAC-SHA-256 digest is 64 hex characters; allow the range so a truncated digest is still rejected. */
const LOOKUP_DIGEST = /^[0-9a-f]{32,128}$/i;

const NATIONAL_ID = /^\d{13}$/;
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

const ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  REUSE: 'REUSE',
  CONFLICT: 'CONFLICT',
  QUARANTINE: 'QUARANTINE',
});

const REASONS = Object.freeze({
  NEW_PERSON: 'NEW_PERSON',
  IDENTIFIER_OWNED_BY_ONE_EMPLOYEE: 'IDENTIFIER_OWNED_BY_ONE_EMPLOYEE',
  EXPLICIT_UID_MATCH: 'EXPLICIT_UID_MATCH',
  NO_IDENTIFIER_SIGNAL: 'NO_IDENTIFIER_SIGNAL',
  EMAIL_MATCH_ONLY: 'EMAIL_MATCH_ONLY',
  NATIONAL_ID_LOOKUP_UNAVAILABLE: 'NATIONAL_ID_LOOKUP_UNAVAILABLE',
  IDENTIFIER_MULTIPLE_OWNERS: 'IDENTIFIER_MULTIPLE_OWNERS',
  CROSS_IDENTIFIER_CONFLICT: 'CROSS_IDENTIFIER_CONFLICT',
  DUPLICATE_WITHIN_BATCH: 'DUPLICATE_WITHIN_BATCH',
  DUPLICATE_EMPLOYEE_UID: 'DUPLICATE_EMPLOYEE_UID',
  EXPLICIT_UID_WITHOUT_IDENTIFIER_MATCH: 'EXPLICIT_UID_WITHOUT_IDENTIFIER_MATCH',
  INVALID_EMPLOYEE_UID: 'INVALID_EMPLOYEE_UID',
});

const WARNINGS = Object.freeze({
  NAME_DIFFERS: 'NAME_DIFFERS',
  EMAIL_DIFFERS: 'EMAIL_DIFFERS',
  EMAIL_OWNED_BY_ANOTHER_EMPLOYEE: 'EMAIL_OWNED_BY_ANOTHER_EMPLOYEE',
  NATIONAL_ID_LOOKED_UP: 'NATIONAL_ID_LOOKED_UP',
});

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

/**
 * Rejects a UID that is not a version-4 UUID. The rejected value is never echoed: a UID is not personal data,
 * but this module is also used by import tools whose logs get shared.
 */
function assertUuidV4(value, { code = 'EMPLOYEE_UID_INVALID', status = 400 } = {}) {
  if (!isUuidV4(value)) {
    throw new HttpError(status, code, 'employee_uid must be a version-4 UUID');
  }
  return value;
}

/**
 * Allocates the UID for one verified person.
 *
 * `existingUid` present => REUSE that exact value (never regenerated). Otherwise CREATE from `uuidFactory`,
 * which is called with **no arguments**, so no identifier can influence it. Defaults to crypto.randomUUID
 * (version 4). A factory returning anything that is not a v4 UUID is rejected rather than stored.
 */
function allocateEmployeeUid({ existingUid = null, uuidFactory = randomUUID } = {}) {
  if (existingUid != null && existingUid !== '') {
    return { employeeUid: assertUuidV4(existingUid), action: ACTIONS.REUSE, reason: REASONS.EXPLICIT_UID_MATCH };
  }
  const generated = uuidFactory();
  assertUuidV4(generated, { code: 'EMPLOYEE_UID_INVALID_GENERATOR', status: 500 });
  return { employeeUid: generated, action: ACTIONS.CREATE, reason: REASONS.NEW_PERSON };
}

/** Fails closed when a caller tries to re-key a person that already has a UID. */
function assertEmployeeUidUnchanged({ employeeUid, proposedEmployeeUid } = {}) {
  if (employeeUid == null) {
    throw new HttpError(400, 'EMPLOYEE_UID_MISSING', 'employee_uid is required');
  }
  if (proposedEmployeeUid == null) {
    // A caller that cannot name the UID it is about to write is a bug, not a no-op: fail closed.
    throw new HttpError(400, 'EMPLOYEE_UID_MISSING', 'proposed employee_uid is required');
  }
  if (proposedEmployeeUid === employeeUid) return employeeUid;
  throw new HttpError(409, 'EMPLOYEE_UID_IMMUTABLE', 'employee_uid cannot be changed once allocated');
}

/** No code path in F4 merges two identified people. This guard exists so a future caller has to argue with it. */
function assertNoAutomaticMerge({ sourceEmployeeUids = [] } = {}) {
  const distinct = new Set(sourceEmployeeUids.filter(Boolean));
  if (distinct.size > 1) {
    throw new HttpError(409, 'IDENTITY_MERGE_NOT_AUTOMATIC', 'merging two employee_uid values requires owner approval');
  }
  return true;
}

/** Canonical 13 digits, or '' — never raw text. Same rule the national-ID contract applies. */
function canonicalNationalId(raw) {
  if (raw == null) return '';
  const text = String(raw).normalize('NFKC').trim();
  if (!text) return '';
  const ascii = text.replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)));
  if (!/^[\d\s-]+$/.test(ascii)) return '';
  const digits = ascii.replace(/[\s-]/g, '');
  return NATIONAL_ID.test(digits) ? digits : '';
}

/**
 * Splits an identifier input into (a) keys that can prove ownership and (b) a raw national ID that must be
 * converted before it can be used. Accepts either the DB shape (`[{ type, value }]`) or a plain map.
 *
 * A raw `national_id` supplied on an *existing* row is deliberately not promoted to a key: the database stores
 * a digest, so a raw value there is either a caller mistake or a fixture that does not model production.
 */
function normalizeIdentifiers(input = {}) {
  const pairs = Array.isArray(input) ? input.map((row) => [row?.type, row?.value]) : Object.entries(input);
  const matchKeys = {};
  let nationalId = null;
  for (const [type, raw] of pairs) {
    if (raw == null || String(raw).trim() === '') continue;
    if (type === 'national_id') {
      const digits = canonicalNationalId(raw);
      if (digits) nationalId = digits;
      continue;
    }
    if (type === 'national_id_lookup') {
      const value = String(raw).trim();
      if (LOOKUP_DIGEST.test(value)) matchKeys.national_id_lookup = value.toLowerCase();
      continue;
    }
    if (IDENTIFIER_TYPES.includes(type)) {
      matchKeys[type] = String(raw).trim();
    }
  }
  return { matchKeys, nationalId };
}

function freezeDecision(decision) {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]),
    warnings: Object.freeze([...decision.warnings]),
    matchedBy: Object.freeze([...decision.matchedBy]),
    identifiersToAttach: Object.freeze([...decision.identifiersToAttach]),
  });
}

function buildOwnershipIndex(existing, nationalIdLookup = null) {
  const ownership = new Map();
  const byEmail = new Map();
  const identities = new Map();
  for (const row of existing) {
    const employeeUid = row?.employeeUid;
    if (!employeeUid) continue;
    const email = row.email ? String(row.email).trim().toLowerCase() : null;
    identities.set(employeeUid, { email, fullName: row.fullName ?? null });
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, new Set());
      byEmail.get(email).add(employeeUid);
    }
    const { matchKeys, nationalId } = normalizeIdentifiers(row.identifiers ?? {});
    // A raw national ID on an existing row cannot match anything the database stores. Converting it is fine
    // when a lookup function is available; ignoring it would hide a duplicate, so it fails closed instead.
    if (nationalId != null) {
      if (nationalIdLookup == null) {
        throw new HttpError(
          500,
          'EXISTING_NATIONAL_ID_UNVERIFIABLE',
          'an existing employee supplied a raw national ID; pass the stored lookup digest or a nationalIdLookup function',
        );
      }
      const digest = nationalIdLookup(nationalId);
      if (typeof digest !== 'string' || !LOOKUP_DIGEST.test(digest)) {
        throw new HttpError(500, 'EXISTING_NATIONAL_ID_UNVERIFIABLE', 'nationalIdLookup did not return a lookup digest');
      }
      matchKeys.national_id_lookup = digest.toLowerCase();
    }
    for (const [type, value] of Object.entries(matchKeys)) {
      const key = `${type}:${value}`;
      if (!ownership.has(key)) ownership.set(key, new Set());
      ownership.get(key).add(employeeUid);
    }
  }
  return { ownership, byEmail, identities };
}

/**
 * Plans UID allocation for a batch of candidates against the identifiers that already exist.
 *
 * Never returns a row that re-points or merges an existing employee. The caller decides what to do with
 * CONFLICT and QUARANTINE rows — by policy a human does, and the row is not imported.
 *
 * @param {object} input
 * @param {Array<{candidateRef?:string, employeeUid?:string, identifiers?:object|Array, email?:string, fullName?:string}>} input.candidates
 * @param {Array<{employeeUid:string, identifiers?:Array<{type:string, value:string}>|object, email?:string, fullName?:string}>} input.existing
 * @param {() => string} [input.uuidFactory]
 * @param {(nationalId: string) => string} [input.nationalIdLookup] raw national ID -> stored lookup digest
 */
function planIdentityAllocation({
  candidates = [], existing = [], uuidFactory = randomUUID, nationalIdLookup = null,
} = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(existing)) {
    throw new HttpError(400, 'EMPLOYEE_UID_PLAN_INVALID_INPUT', 'candidates and existing must be arrays');
  }
  if (nationalIdLookup != null && typeof nationalIdLookup !== 'function') {
    throw new HttpError(400, 'EMPLOYEE_UID_PLAN_INVALID_INPUT', 'nationalIdLookup must be a function');
  }
  const { ownership, byEmail, identities } = buildOwnershipIndex(existing, nationalIdLookup);
  const claimedUids = new Set(identities.keys());
  const seenExplicitUids = new Set();

  // 1. Two candidate rows claiming the same identifier value => one of them is wrong. Neither is imported.
  const batchOwners = new Map();
  const normalized = candidates.map((candidate, index) => {
    const { matchKeys, nationalId } = normalizeIdentifiers(candidate?.identifiers);
    for (const [type, value] of Object.entries(matchKeys)) {
      const key = `${type}:${value}`;
      if (!batchOwners.has(key)) batchOwners.set(key, new Set());
      batchOwners.get(key).add(index);
    }
    return { index, candidate: candidate ?? {}, matchKeys, nationalId };
  });

  const decisions = normalized.map(({ index, candidate, matchKeys, nationalId }) => {
    const candidateRef = candidate.candidateRef ?? `candidate-${index + 1}`;
    const reasons = [];
    const warnings = [];
    const keys = { ...matchKeys };

    // 1a. The same identifier value twice in one batch is a conflict, not a merge.
    const duplicatedKeys = Object.keys(keys).filter((type) => batchOwners.get(`${type}:${keys[type]}`)?.size > 1);
    const duplicateNationalId = nationalId != null
      && normalized.some((other) => other.index !== index && other.nationalId === nationalId);
    if (duplicatedKeys.length > 0 || duplicateNationalId) reasons.push(REASONS.DUPLICATE_WITHIN_BATCH);

    // 1b. Turn the raw national ID into the only form that can match stored data.
    let nationalIdUnverifiable = false;
    if (nationalId != null) {
      if (nationalIdLookup == null) {
        nationalIdUnverifiable = true;
      } else {
        let digest = null;
        try {
          digest = nationalIdLookup(nationalId);
        } catch {
          digest = null;
        }
        if (typeof digest === 'string' && LOOKUP_DIGEST.test(digest)) {
          keys.national_id_lookup = digest.toLowerCase();
          warnings.push(WARNINGS.NATIONAL_ID_LOOKED_UP);
        } else {
          nationalIdUnverifiable = true;
        }
      }
    }

    // 2. Ownership comes only from identifiers.
    const owners = new Set();
    let multiOwner = false;
    for (const [type, value] of Object.entries(keys)) {
      const ownersOfValue = ownership.get(`${type}:${value}`);
      if (!ownersOfValue) continue;
      if (ownersOfValue.size > 1) multiOwner = true;
      for (const uid of ownersOfValue) owners.add(uid);
    }
    if (multiOwner) reasons.push(REASONS.IDENTIFIER_MULTIPLE_OWNERS);
    if (owners.size > 1) reasons.push(REASONS.CROSS_IDENTIFIER_CONFLICT);

    // 3. An explicitly supplied UID is a re-import carrying its own identity. It must be unique in the batch,
    //    and it must be corroborated by an identifier — otherwise it could attach a person's identifiers to
    //    someone else's UID.
    const explicitUid = candidate.employeeUid == null || candidate.employeeUid === ''
      ? null
      : candidate.employeeUid;
    if (explicitUid != null) {
      if (!isUuidV4(explicitUid)) {
        reasons.push(REASONS.INVALID_EMPLOYEE_UID);
      } else if (seenExplicitUids.has(explicitUid)) {
        reasons.push(REASONS.DUPLICATE_EMPLOYEE_UID);
      } else {
        seenExplicitUids.add(explicitUid);
        if (identities.has(explicitUid)) {
          // Claiming an UID that already belongs to someone: require that this row also proves it is that person.
          if (owners.size === 0) reasons.push(REASONS.EXPLICIT_UID_WITHOUT_IDENTIFIER_MATCH);
          else if (!owners.has(explicitUid)) reasons.push(REASONS.CROSS_IDENTIFIER_CONFLICT);
        } else if (owners.size > 0) {
          reasons.push(REASONS.CROSS_IDENTIFIER_CONFLICT);
        }
      }
    }

    const email = candidate.email ? String(candidate.email).trim().toLowerCase() : null;
    const emailOwners = email ? byEmail.get(email) ?? new Set() : new Set();

    // 4. Blocking outcomes first, in the order a human would want to read them.
    if (reasons.length > 0) {
      return freezeDecision({
        candidateRef,
        action: ACTIONS.CONFLICT,
        employeeUid: null,
        matchedBy: [],
        identifiersToAttach: [],
        reasons,
        warnings,
      });
    }

    // 5. Nothing to match on: a name or email alone is never identity.
    if (Object.keys(keys).length === 0) {
      if (nationalIdUnverifiable) {
        return freezeDecision({
          candidateRef,
          action: ACTIONS.QUARANTINE,
          employeeUid: null,
          matchedBy: [],
          identifiersToAttach: [],
          reasons: [REASONS.NATIONAL_ID_LOOKUP_UNAVAILABLE],
          warnings,
        });
      }
      return freezeDecision({
        candidateRef,
        action: ACTIONS.QUARANTINE,
        employeeUid: null,
        matchedBy: [],
        identifiersToAttach: [],
        reasons: [emailOwners.size > 0 ? REASONS.EMAIL_MATCH_ONLY : REASONS.NO_IDENTIFIER_SIGNAL],
        warnings,
      });
    }

    // 6. A verified match reuses the stored UID verbatim.
    if (owners.size === 1) {
      const [employeeUid] = [...owners];
      const known = identities.get(employeeUid);
      if (email && known?.email && known.email !== email) warnings.push(WARNINGS.EMAIL_DIFFERS);
      if (emailOwners.size > 0 && !emailOwners.has(employeeUid)) warnings.push(WARNINGS.EMAIL_OWNED_BY_ANOTHER_EMPLOYEE);
      if (candidate.fullName && known?.fullName && known.fullName !== candidate.fullName) warnings.push(WARNINGS.NAME_DIFFERS);
      claimedUids.add(employeeUid);
      const alreadyOwned = new Set(
        Object.entries(keys).filter(([type, value]) => ownership.get(`${type}:${value}`)?.has(employeeUid)).map(([type]) => type),
      );
      return freezeDecision({
        candidateRef,
        action: ACTIONS.REUSE,
        employeeUid,
        matchedBy: [explicitUid ? REASONS.EXPLICIT_UID_MATCH : REASONS.IDENTIFIER_OWNED_BY_ONE_EMPLOYEE],
        identifiersToAttach: Object.keys(keys).filter((type) => !alreadyOwned.has(type)),
        reasons: [],
        warnings,
      });
    }

    // 7. A national ID that could not be verified means ownership is unknown: never mint a UID on top of that.
    if (nationalIdUnverifiable) {
      return freezeDecision({
        candidateRef,
        action: ACTIONS.QUARANTINE,
        employeeUid: null,
        matchedBy: [],
        identifiersToAttach: [],
        reasons: [REASONS.NATIONAL_ID_LOOKUP_UNAVAILABLE],
        warnings,
      });
    }

    // 8. Only a genuinely new person gets a UID, and it is generated fresh (or is the caller's explicit,
    //    previously-unknown UID).
    if (emailOwners.size > 0) warnings.push(WARNINGS.EMAIL_OWNED_BY_ANOTHER_EMPLOYEE);
    let employeeUid;
    if (explicitUid != null) {
      employeeUid = explicitUid;
    } else {
      employeeUid = uuidFactory();
      assertUuidV4(employeeUid, { code: 'EMPLOYEE_UID_INVALID_GENERATOR', status: 500 });
    }
    if (claimedUids.has(employeeUid)) {
      throw new HttpError(500, 'EMPLOYEE_UID_COLLISION', 'a UID that is already claimed was allocated again');
    }
    claimedUids.add(employeeUid);
    return freezeDecision({
      candidateRef,
      action: ACTIONS.CREATE,
      employeeUid,
      matchedBy: [],
      identifiersToAttach: Object.keys(keys),
      reasons: [REASONS.NEW_PERSON],
      warnings,
    });
  });

  const summary = {
    total: decisions.length,
    create: decisions.filter((d) => d.action === ACTIONS.CREATE).length,
    reuse: decisions.filter((d) => d.action === ACTIONS.REUSE).length,
    quarantine: decisions.filter((d) => d.action === ACTIONS.QUARANTINE).length,
    conflict: decisions.filter((d) => d.action === ACTIONS.CONFLICT).length,
  };

  return Object.freeze({ policy: POLICY, decisions: Object.freeze(decisions), summary: Object.freeze(summary) });
}

module.exports = {
  POLICY,
  ACTIONS,
  REASONS,
  WARNINGS,
  IDENTIFIER_TYPES,
  MATCH_KEY_TYPES,
  STRONG_IDENTIFIER_TYPES: IDENTIFIER_TYPES,
  UUID_V4,
  isUuidV4,
  assertUuidV4,
  allocateEmployeeUid,
  assertEmployeeUidUnchanged,
  assertNoAutomaticMerge,
  canonicalNationalId,
  normalizeIdentifiers,
  planIdentityAllocation,
};
