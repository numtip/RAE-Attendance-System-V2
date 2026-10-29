/**
 * National-ID protection: canonicalisation, checksum, masking, and a VERSIONED HMAC-SHA-256 lookup.
 *
 * ## The rule this module exists to enforce
 *
 * A Thai national ID must never be stored, logged, or returned in the clear. It is a 13-digit identifier that
 * cannot be rotated, so a leak is permanent. The only durable way to match one is to store a **keyed** digest
 * and compare digests.
 *
 * ## Why HMAC and never a plain SHA-256
 *
 * A Thai national ID has a 12-digit body plus a checksum digit, and the body follows a known region/office
 * prefix structure. That leaves a search space small enough to enumerate exhaustively. An unkeyed
 * `sha256('9900000000002')` is therefore **not** a pseudonym: anyone with the algorithm can rebuild the table
 * and reverse every stored value. Only a server-held secret makes the digest irreversible in practice. This is
 * why `createHash` is never used for identity matching here, and a test asserts that.
 *
 * ## Versioning
 *
 * Keys are versioned so they can be rotated without losing the ability to match existing rows:
 *   * **writes** use the highest configured version;
 *   * **lookups** compute a digest for *every* acceptable version and try them all.
 * The stored row therefore records which version produced it (`employee_identifier.lookup_key_version`, added
 * by migration `015_employee_identifier_secure_lookup`), while a lookup needs no prior knowledge of it.
 *
 * Rotating a key does not silently orphan data: the old version stays acceptable until an explicit reindex
 * rewrites the rows. `planReindex` exposes that as data, so the decision is reviewable rather than implicit.
 *
 * ## Fail-closed by default
 *
 * With no key configured, `createNationalIdProtector` throws rather than falling back to plaintext or to an
 * unkeyed hash. Every entry point that could persist an identifier goes through this module, so "no key" means
 * "this feature is unavailable", never "store it unprotected".
 *
 * Everything here is pure: no I/O, no database, no clock, no environment access. The caller supplies the keys.
 */

const { createHmac, timingSafeEqual } = require('node:crypto');

/** Canonical form: exactly 13 ASCII digits. */
const NATIONAL_ID = /^\d{13}$/;

/** A stored lookup digest: lowercase hex, 64 characters (HMAC-SHA-256). */
const LOOKUP_DIGEST = /^[0-9a-f]{64}$/;

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/** Minimum secret length. A short key weakens the whole scheme, so this is enforced, not documented. */
const MIN_KEY_BYTES = 32;

class NationalIdError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Canonicalises a Thai national ID: NFKC, Thai digits folded to ASCII, separators stripped.
 *
 * Returns `''` for anything that is not exactly 13 digits. This is deliberately **fail-closed**: the previous
 * behaviour (`main`'s `normalizeIdentifierValue`) returned the raw text when the digit count was wrong, which
 * would have hashed arbitrary user input into a "lookup value".
 */
function canonicalizeNationalId(raw) {
  if (raw == null) return '';
  const text = String(raw).normalize('NFKC');
  const ascii = text.replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)));
  if (!/^[\d\s-]+$/.test(ascii)) return '';
  const digits = ascii.replace(/[\s-]/g, '');
  return NATIONAL_ID.test(digits) ? digits : '';
}

/**
 * Thai citizen-ID checksum (mod 11 over the first 12 digits).
 *
 * Used by the fixture-hygiene guard to tell a synthetic value from a real-looking one. It is deliberately NOT
 * enforced on write: a checksum typo is stored as an unmatchable digest rather than rejected, because rejecting
 * it would also reject the checksum-invalid synthetics the tests depend on. It is **not** an access control: a
 * value that passes the checksum is still treated as personal data.
 */
function isValidNationalIdChecksum(canonical) {
  if (!NATIONAL_ID.test(canonical)) return false;
  const sum = canonical
    .slice(0, 12)
    .split('')
    .reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  return ((11 - (sum % 11)) % 11) % 10 === Number(canonical[12]);
}

/**
 * Masks a national ID for display or logs: `****` plus the last four digits, or `[redacted]` for anything that
 * is not canonical. Four trailing digits are the conventional minimum for a human to confirm "yes, that one".
 */
function maskNationalId(raw) {
  const canonical = canonicalizeNationalId(raw);
  if (!canonical) return '[redacted]';
  return `****${canonical.slice(-4)}`;
}

/**
 * Detects something that looks like a national ID in free text (a log line, an error message, a response).
 *
 * Tolerant of the four encodings that have bitten this project before: plain, dashed/spaced, Thai digits and
 * full-width digits. Separators make a run longer than 13 characters (a fully dashed ID is 25), so the digits
 * are extracted and every 13-digit window is tested. Testing windows rather than the whole run means two IDs
 * printed next to each other are still caught, instead of collapsing into a 26-digit non-match.
 */
function containsNationalIdLike(text) {
  if (text == null) return false;
  const source = String(text).normalize('NFKC');
  const run = /[0-9๐-๙][0-9๐-๙\s-]{10,40}/g;
  for (const candidate of source.match(run) || []) {
    const digits = candidate
      .replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)))
      .replace(/[\s-]/g, '');
    if (digits.length < 13) continue;
    for (let start = 0; start + 13 <= digits.length; start += 1) {
      if (NATIONAL_ID.test(digits.slice(start, start + 13))) return true;
    }
  }
  return false;
}

/**
 * Validates and normalises a key list into `{ version: Buffer }`.
 *
 * Accepts `{ 1: '<base64 or hex or utf8>' }` or an array of raw strings, in ascending version order. Keys are
 * interpreted as base64 when they decode cleanly to at least `MIN_KEY_BYTES`, otherwise as UTF-8 bytes — the
 * same convention as `EMPLOYEE_IDENTIFIER_HMAC_KEY`.
 */
function normalizeKeys(input) {
  if (input == null) {
    throw new NationalIdError('NATIONAL_ID_KEY_MISSING', 'a national-ID HMAC key must be configured');
  }
  const entries = Array.isArray(input)
    ? input.map((value, index) => [index + 1, value])
    : Object.entries(input).map(([version, value]) => [Number(version), value]);

  if (entries.length === 0) {
    throw new NationalIdError('NATIONAL_ID_KEY_MISSING', 'at least one national-ID HMAC key is required');
  }

  const keys = new Map();
  for (const [version, value] of entries) {
    if (!Number.isInteger(version) || version < 1) {
      throw new NationalIdError('NATIONAL_ID_KEY_VERSION_INVALID', 'key versions must be positive integers');
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new NationalIdError('NATIONAL_ID_KEY_INVALID', 'a national-ID HMAC key must be a non-empty string');
    }
    let bytes = null;
    try {
      const decoded = Buffer.from(value, 'base64');
      // Round-trip check: only treat it as base64 if it decodes to enough bytes and re-encodes identically.
      const isBase64 = decoded.length >= MIN_KEY_BYTES
        && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
      bytes = isBase64 ? decoded : Buffer.from(value, 'utf8');
    } catch {
      bytes = Buffer.from(value, 'utf8');
    }
    if (bytes.length < MIN_KEY_BYTES) {
      throw new NationalIdError(
        'NATIONAL_ID_KEY_TOO_SHORT',
        `a national-ID HMAC key must be at least ${MIN_KEY_BYTES} bytes`,
      );
    }
    keys.set(version, bytes);
  }
  return keys;
}

/**
 * Builds the protector.
 *
 * @param {object} options
 * @param {Record<number,string>|string[]} options.keys     versioned secrets; the highest version is used for writes
 * @param {number} [options.writeVersion]                   override which version new digests use
 * @param {number[]} [options.acceptVersions]               restrict lookup to these versions (default: all)
 */
function createNationalIdProtector({ keys: keyInput, writeVersion = null, acceptVersions = null } = {}) {
  const keys = normalizeKeys(keyInput);
  const versions = [...keys.keys()].sort((a, b) => a - b);
  const highest = versions[versions.length - 1];
  const write = writeVersion ?? highest;

  if (!keys.has(write)) {
    throw new NationalIdError('NATIONAL_ID_KEY_VERSION_INVALID', 'writeVersion is not a configured key');
  }
  const accepted = (acceptVersions ?? versions).filter((v) => keys.has(v));
  if (accepted.length === 0) {
    throw new NationalIdError('NATIONAL_ID_KEY_VERSION_INVALID', 'no acceptable lookup key version');
  }

  /** HMAC-SHA-256 of the canonical ID under one version. The ID is never stored, only returned as a digest. */
  function digestFor(canonical, version) {
    return createHmac('sha256', keys.get(version)).update(canonical, 'utf8').digest('hex');
  }

  return Object.freeze({
    /** Which version a new write will use. Persisted alongside the digest. */
    writeVersion: write,

    /** All versions a lookup will accept, ascending. */
    acceptVersions: Object.freeze([...accepted]),

    /**
     * Produces the value to persist for a raw national ID.
     * Throws on an invalid ID rather than returning a hash of junk.
     */
    protect(raw) {
      const canonical = canonicalizeNationalId(raw);
      if (!canonical) {
        throw new NationalIdError('NATIONAL_ID_INVALID', 'a national ID must be exactly 13 digits');
      }
      return Object.freeze({
        lookup: digestFor(canonical, write),
        keyVersion: write,
        // A masked form for logging; the caller must never log `canonical`.
        masked: maskNationalId(canonical),
      });
    },

    /**
     * Every digest a stored row could hold for this raw ID, newest version first.
     *
     * Used for lookup: `employee_identifier.id_value` must equal one of these. A row written under an older key
     * stays matchable without knowing its version, which is what makes rotation non-breaking.
     */
    lookupCandidates(raw) {
      const canonical = canonicalizeNationalId(raw);
      if (!canonical) return Object.freeze([]);
      return Object.freeze(
        [...accepted].sort((a, b) => b - a).map((version) => Object.freeze({
          lookup: digestFor(canonical, version),
          keyVersion: version,
        })),
      );
    },

    /** Constant-time comparison of two stored digests, for callers that hold both. */
    digestsEqual(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      if (!LOOKUP_DIGEST.test(a) || !LOOKUP_DIGEST.test(b)) return false;
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    },

    /**
     * Plans a key rotation WITHOUT performing it: which rows would need rewriting, and to what.
     * Pure — the caller decides whether to apply it.
     */
    planReindex(rows = []) {
      const targets = [];
      let current = 0;
      for (const row of rows) {
        if (row?.keyVersion === write) { current += 1; continue; }
        targets.push(Object.freeze({ id: row?.id ?? null, fromVersion: row?.keyVersion ?? null, toVersion: write }));
      }
      return Object.freeze({
        writeVersion: write,
        alreadyCurrent: current,
        needsReindex: targets.length,
        targets: Object.freeze(targets),
        // Rows cannot be re-digested from a digest; the raw value must be supplied by the caller.
        requiresRawValues: targets.length > 0,
      });
    },
  });
}

/**
 * Reads versioned keys from an environment-like object and builds the protector.
 *
 * Accepted forms, in priority order:
 *   NATIONAL_ID_HMAC_KEYS        = '1:<key>,2:<key>'   (preferred; explicit versions)
 *   NATIONAL_ID_HMAC_KEY[_V<n>]  = '<key>'             (single or numbered)
 *
 * There is NO fallback to an unkeyed hash and NO default key. A missing key is an error, which is what makes
 * this fail closed: the feature is unavailable rather than unsafe.
 */
function protectorFromEnv(env = process.env) {
  const many = env.NATIONAL_ID_HMAC_KEYS;
  if (many != null && String(many).trim() !== '') {
    const keys = {};
    for (const part of String(many).split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) {
        throw new NationalIdError('NATIONAL_ID_KEY_INVALID', 'NATIONAL_ID_HMAC_KEYS entries must be <version>:<key>');
      }
      keys[Number(trimmed.slice(0, idx))] = trimmed.slice(idx + 1);
    }
    return createNationalIdProtector({ keys });
  }

  const keys = {};
  if (env.NATIONAL_ID_HMAC_KEY) keys[1] = env.NATIONAL_ID_HMAC_KEY;
  for (const [name, value] of Object.entries(env)) {
    const match = /^NATIONAL_ID_HMAC_KEY_V(\d+)$/.exec(name);
    if (match && value) keys[Number(match[1])] = value;
  }
  if (Object.keys(keys).length === 0) {
    throw new NationalIdError(
      'NATIONAL_ID_KEY_MISSING',
      'NATIONAL_ID_HMAC_KEYS (or NATIONAL_ID_HMAC_KEY) must be configured; national-ID matching is unavailable without it',
    );
  }
  return createNationalIdProtector({ keys });
}

module.exports = {
  NATIONAL_ID,
  LOOKUP_DIGEST,
  MIN_KEY_BYTES,
  NationalIdError,
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
  containsNationalIdLike,
  normalizeKeys,
  createNationalIdProtector,
  protectorFromEnv,
};
