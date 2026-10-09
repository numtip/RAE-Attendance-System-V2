'use strict';
/**
 * SINGLE National ID protection contract (docs/NATIONAL_ID_PROTECTION_POLICY.md).
 * Consumers: backend repositories/services, scripts/data-onboarding (via identifierCrypto.mjs),
 * and the idcard CSV tooling (via the same ESM re-export). Do not re-implement any of this elsewhere.
 *
 *  - Canonical input: NFKC, Thai digits -> ASCII, only whitespace/hyphen separators allowed, exactly 13 digits.
 *  - Lookup: HMAC-SHA-256(key[version], DOMAIN \0 id_type \0 canonical) -> lowercase hex. Never plain SHA.
 *  - Keys: environment or <NAME>_FILE (secret manager mount); current + optional previous (rotation window).
 *  - Raw storage: DISABLED unless EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED === 'true' AND an approved
 *    necessity reference is supplied; AES-256-GCM with a key independent of the HMAC key.
 *  - Errors expose only a code. Audit events are metadata-only and reject anything that looks like PII.
 */
const {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const { readFileSync } = require('node:fs');

const CONTRACT_VERSION = 'v1';
const LOOKUP_DOMAIN = 'rae-attendance-v2:identifier-lookup:v1';
const AAD_DOMAIN = 'rae-attendance-v2:identifier-secret:v1';
const MIN_HMAC_KEY_BYTES = 32;
const ENCRYPTION_KEY_BYTES = 32;
const PROTECTED_ID_TYPES = Object.freeze(['national_id']);
const AUDIT_ACTIONS = Object.freeze(['lookup', 'create', 'decrypt', 'reindex', 'delete', 'key_rotation']);
const WRITE_LOCK_NAME = 'rae:employee_identifier:national_id:write';

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

class IdentifierCryptoError extends Error {
  constructor(code) {
    super(code); // code only — never include values
    this.name = 'IdentifierCryptoError';
    this.code = code;
  }
}

/* ---------- canonicalization ---------- */

/** Returns the canonical 13-digit string or '' when the input is not a valid-shaped National ID. */
function canonicalizeNationalId(raw) {
  if (raw == null) return '';
  let text = String(raw).normalize('NFKC');
  text = text.replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)));
  if (!/^[\d\s-]+$/.test(text)) return '';
  const digits = text.replace(/[\s-]/g, '');
  return /^\d{13}$/.test(digits) ? digits : '';
}

/** Thai citizen-ID checksum. A separate screening rule — NOT part of lookup canonicalization. */
function isValidNationalIdChecksum(canonical) {
  if (!/^\d{13}$/.test(canonical)) return false;
  const sum = canonical
    .slice(0, 12)
    .split('')
    .reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  return ((11 - (sum % 11)) % 10) === Number(canonical[12]);
}

function maskNationalId(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : '[redacted]';
}

function requireCanonical(idType, raw) {
  if (!PROTECTED_ID_TYPES.includes(idType)) throw new IdentifierCryptoError('UNSUPPORTED_ID_TYPE');
  const canonical = canonicalizeNationalId(raw);
  if (!canonical) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
  return canonical;
}

/* ---------- key loading ---------- */

function readSecretText(env, name) {
  const direct = env[name];
  if (direct != null && String(direct).trim() !== '') return String(direct).trim();
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch {
      throw new IdentifierCryptoError(`SECRET_FILE_UNREADABLE:${name}`);
    }
  }
  return '';
}

function decodeBase64Key(text, label, { exactBytes = null, minBytes = MIN_HMAC_KEY_BYTES } = {}) {
  if (!text) throw new IdentifierCryptoError(`KEY_MISSING:${label}`);
  const buf = Buffer.from(text, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new IdentifierCryptoError(`KEY_NOT_BASE64:${label}`);
  }
  if (exactBytes !== null && buf.length !== exactBytes) {
    throw new IdentifierCryptoError(`KEY_BAD_LENGTH:${label}`);
  }
  if (buf.length < minBytes) throw new IdentifierCryptoError(`KEY_TOO_SHORT:${label}`);
  return buf;
}

function parseVersion(text, label) {
  if (!/^[1-9]\d{0,4}$/.test(text || '')) throw new IdentifierCryptoError(`KEY_VERSION_INVALID:${label}`);
  return Number(text);
}

function loadIdentifierKeys(env = process.env, { requireEncryption = false } = {}) {
  const current = {
    version: parseVersion(env.EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION, 'EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION'),
    key: decodeBase64Key(readSecretText(env, 'EMPLOYEE_IDENTIFIER_HMAC_KEY'), 'EMPLOYEE_IDENTIFIER_HMAC_KEY'),
  };
  let previous = null;
  const previousText = readSecretText(env, 'EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS');
  if (previousText) {
    previous = {
      version: parseVersion(
        env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION,
        'EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION',
      ),
      key: decodeBase64Key(previousText, 'EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS'),
    };
    if (previous.version === current.version) throw new IdentifierCryptoError('KEY_VERSION_DUPLICATE');
    if (previous.key.length === current.key.length && timingSafeEqual(previous.key, current.key)) {
      throw new IdentifierCryptoError('KEY_PREVIOUS_EQUALS_CURRENT');
    }
  }

  // Raw National ID storage is DISABLED by default; the encryption key is not even read otherwise.
  const rawStorageEnabled = String(env.EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED || '').trim() === 'true';
  let encryption = null;
  if (rawStorageEnabled || requireEncryption) {
    const keyId = String(env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID || '').trim();
    if (!keyId) throw new IdentifierCryptoError('KEY_ID_MISSING:EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID');
    encryption = {
      keyId,
      key: decodeBase64Key(
        readSecretText(env, 'EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY'),
        'EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY',
        { exactBytes: ENCRYPTION_KEY_BYTES, minBytes: ENCRYPTION_KEY_BYTES },
      ),
    };
  }

  for (const hmac of [current, previous].filter(Boolean)) {
    if (encryption && hmac.key.length === encryption.key.length && timingSafeEqual(hmac.key, encryption.key)) {
      throw new IdentifierCryptoError('KEY_REUSE_HMAC_AND_ENCRYPTION');
    }
  }
  // Rotation write-freeze: blocks national_id INSERTs (reads continue) while instances hold mixed key sets.
  const writeFrozen = String(env.EMPLOYEE_IDENTIFIER_NATIONAL_WRITE_FREEZE || '').trim() === 'true';
  return { hmac: { current, previous }, encryption, rawStorageEnabled, writeFrozen };
}

/* ---------- HMAC lookup ---------- */

function identifierLookupHmac(idType, rawValue, hmacKeyEntry) {
  const value = requireCanonical(idType, rawValue);
  if (!hmacKeyEntry?.key || !Number.isInteger(hmacKeyEntry.version)) {
    throw new IdentifierCryptoError('KEY_ENTRY_INVALID');
  }
  return createHmac('sha256', hmacKeyEntry.key)
    .update(`${LOOKUP_DOMAIN}\0${idType}\0${value}`, 'utf8')
    .digest('hex');
}

function buildLookup(idType, rawValue, keys) {
  const entry = keys.hmac.current;
  return { lookup_hmac: identifierLookupHmac(idType, rawValue, entry), key_version: entry.version };
}

/** Current first, then previous: read paths must try both during a rotation window. */
function buildLookupCandidates(idType, rawValue, keys) {
  return [keys.hmac.current, keys.hmac.previous]
    .filter(Boolean)
    .map((entry) => ({ lookup_hmac: identifierLookupHmac(idType, rawValue, entry), key_version: entry.version }));
}

/* ---------- AES-256-GCM (approved necessity only) ---------- */

function encryptRawIdentifier(idType, rawValue, keys, { necessityApprovalRef } = {}) {
  if (!keys.rawStorageEnabled) throw new IdentifierCryptoError('RAW_STORAGE_DISABLED');
  if (!String(necessityApprovalRef || '').trim()) throw new IdentifierCryptoError('NECESSITY_APPROVAL_REQUIRED');
  if (!keys.encryption) throw new IdentifierCryptoError('ENCRYPTION_KEY_NOT_CONFIGURED');
  const value = requireCanonical(idType, rawValue);
  const lookup = buildLookup(idType, value, keys);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption.key, iv);
  cipher.setAAD(Buffer.from(`${AAD_DOMAIN}:${idType}:${lookup.lookup_hmac}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    id_type: idType,
    ciphertext,
    iv,
    auth_tag: cipher.getAuthTag(),
    enc_key_id: keys.encryption.keyId,
    lookup_hmac: lookup.lookup_hmac,
    key_version: lookup.key_version,
    necessity_ref: String(necessityApprovalRef).trim(),
  };
}

function decryptRawIdentifier(envelope, keys) {
  if (!keys.rawStorageEnabled) throw new IdentifierCryptoError('RAW_STORAGE_DISABLED');
  if (!keys.encryption) throw new IdentifierCryptoError('ENCRYPTION_KEY_NOT_CONFIGURED');
  const decipher = createDecipheriv('aes-256-gcm', keys.encryption.key, envelope.iv);
  decipher.setAAD(Buffer.from(`${AAD_DOMAIN}:${envelope.id_type}:${envelope.lookup_hmac}`, 'utf8'));
  decipher.setAuthTag(envelope.auth_tag);
  try {
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new IdentifierCryptoError('DECRYPT_FAILED');
  }
}

/* ---------- audit (metadata only) ---------- */

const SAFE_TEXT = /^[A-Za-z0-9:_@./ -]{1,255}$/;

/**
 * Builds an audit row. Rejects free text that is not a plain token or that contains a run of 10+ digits
 * (so a raw/partial National ID cannot be smuggled in through actor/reason).
 */
function buildAuditEvent({ action, actor, reason, keyVersion = null, employeeUid = null, identifierId = null, now = new Date() }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new IdentifierCryptoError('AUDIT_ACTION_INVALID');
  for (const text of [actor, reason]) {
    if (!SAFE_TEXT.test(String(text ?? '')) || /\d{10,}/.test(String(text))) {
      throw new IdentifierCryptoError('AUDIT_TEXT_REJECTED');
    }
  }
  if (keyVersion != null && !Number.isInteger(keyVersion)) throw new IdentifierCryptoError('AUDIT_KEY_VERSION_INVALID');
  return {
    identifier_id: identifierId,
    employee_uid: employeeUid,
    action,
    key_version: keyVersion,
    actor: String(actor),
    reason: String(reason),
    created_at: now,
  };
}

/* ---------- duplicate + reindex planning (pure) ---------- */

/**
 * Cross-version duplicate check. UNIQUE(id_type,id_value) cannot see that one person under key v1 and
 * v2 is the same identity. Call inside the write transaction while holding WRITE_LOCK_NAME.
 * `existingRows`: [{ id, employee_uid, id_value, lookup_key_version }].
 */
function detectCrossVersionDuplicates(candidates, existingRows, keys) {
  const byValue = new Map(existingRows.map((row) => [row.id_value, row]));
  const matches = [];
  for (const { ref, raw } of candidates) {
    const canonical = requireCanonical('national_id', raw);
    const probes = [canonical, ...buildLookupCandidates('national_id', canonical, keys).map((c) => c.lookup_hmac)];
    for (const probe of probes) {
      const hit = byValue.get(probe);
      if (hit) {
        matches.push({
          ref,
          existing_row_id: hit.id,
          existing_employee_uid: hit.employee_uid,
          existing_key_version: hit.lookup_key_version ?? null,
          legacy_plaintext: probe === canonical,
        });
        break;
      }
    }
  }
  return matches;
}

function planReindex(rows, keys, { resolveRaw = () => null } = {}) {
  const current = keys.hmac.current;
  const updates = [];
  const unresolved = [];
  const skippedCurrent = [];
  const target = new Map();
  const collisions = [];
  const existingValues = new Map(rows.map((row) => [row.id_value, row]));

  for (const row of rows) {
    if (row.lookup_key_version === current.version) {
      skippedCurrent.push(row.id);
      continue;
    }
    const legacy = row.lookup_key_version == null && /^\d{13}$/.test(String(row.id_value));
    const raw = legacy ? row.id_value : resolveRaw(row);
    if (!raw) {
      unresolved.push(row.id);
      continue;
    }
    const newLookup = identifierLookupHmac('national_id', raw, current);
    const clash = target.get(newLookup);
    if (clash) {
      collisions.push({ row_ids: [clash.id, row.id], employee_uids: [clash.employee_uid, row.employee_uid] });
      continue;
    }
    const other = existingValues.get(newLookup);
    if (other && other.id !== row.id) {
      collisions.push({ row_ids: [other.id, row.id], employee_uids: [other.employee_uid, row.employee_uid] });
      continue;
    }
    target.set(newLookup, row);
    updates.push({
      id: row.id,
      employee_uid: row.employee_uid,
      from_version: row.lookup_key_version ?? null,
      to_version: current.version,
      new_id_value: newLookup,
    });
  }
  return { ok: collisions.length === 0 && unresolved.length === 0, updates, unresolved, skipped_current: skippedCurrent, collisions };
}

/* ---------- protector facade (what runtime code uses) ---------- */

/**
 * Lazy facade: construction never throws. If keys are missing/invalid the protector is `configured:false`
 * and every operation fails closed with NOT_CONFIGURED (no plaintext fallback, ever).
 */
function createNationalIdProtector(env = process.env) {
  let keys = null;
  let configError = null;
  try {
    keys = loadIdentifierKeys(env);
  } catch (error) {
    configError = error.code || 'KEY_CONFIG_INVALID';
  }
  const need = () => {
    if (!keys) throw new IdentifierCryptoError(`NOT_CONFIGURED:${configError}`);
    return keys;
  };
  return {
    get configured() {
      return keys !== null;
    },
    get configError() {
      return configError;
    },
    get rawStorageEnabled() {
      return Boolean(keys?.rawStorageEnabled);
    },
    get writeFrozen() {
      return Boolean(keys?.writeFrozen);
    },
    /** Throws NOT_CONFIGURED or NATIONAL_ID_WRITES_FROZEN; call before any national_id write. */
    assertWritable() {
      if (need().writeFrozen) throw new IdentifierCryptoError('NATIONAL_ID_WRITES_FROZEN');
    },
    get keyVersion() {
      return keys ? keys.hmac.current.version : null;
    },
    canonicalize: canonicalizeNationalId,
    lookupCurrent: (raw) => buildLookup('national_id', raw, need()),
    lookupCandidates: (raw) => buildLookupCandidates('national_id', raw, need()),
    detectCrossVersionDuplicates: (candidates, rows) => detectCrossVersionDuplicates(candidates, rows, need()),
    planReindex: (rows, options) => planReindex(rows, need(), options),
    encryptRaw: (raw, options) => encryptRawIdentifier('national_id', raw, need(), options),
    decryptRaw: (envelope) => decryptRawIdentifier(envelope, need()),
    keys: need,
  };
}

module.exports = {
  CONTRACT_VERSION,
  LOOKUP_DOMAIN,
  AAD_DOMAIN,
  AUDIT_ACTIONS,
  WRITE_LOCK_NAME,
  IdentifierCryptoError,
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
  loadIdentifierKeys,
  identifierLookupHmac,
  buildLookup,
  buildLookupCandidates,
  encryptRawIdentifier,
  decryptRawIdentifier,
  buildAuditEvent,
  detectCrossVersionDuplicates,
  planReindex,
  createNationalIdProtector,
};
