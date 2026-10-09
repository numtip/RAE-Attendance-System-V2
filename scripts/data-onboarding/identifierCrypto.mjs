/**
 * National ID protection helpers (policy: docs/NATIONAL_ID_PROTECTION_POLICY.md).
 *
 * - Exact lookup: HMAC-SHA-256 with a *versioned* key. Plain SHA is never used.
 * - Raw storage: AES-256-GCM, only with a documented/approved necessity reference.
 * - HMAC key and encryption key are independent; equal keys are rejected.
 * - Keys come from environment or a `<NAME>_FILE` secret mount (secret manager / Docker / k8s).
 *   Key material is never logged, never put into errors, never hard-coded.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

const LOOKUP_DOMAIN = 'rae-attendance-v2:identifier-lookup:v1';
const AAD_DOMAIN = 'rae-attendance-v2:identifier-secret:v1';
const MIN_HMAC_KEY_BYTES = 32;
const ENCRYPTION_KEY_BYTES = 32;
const IDENTIFIER_TYPES = new Set(['national_id']);

export class IdentifierCryptoError extends Error {
  constructor(code) {
    super(code); // code only — never include values
    this.name = 'IdentifierCryptoError';
    this.code = code;
  }
}

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

/**
 * Loads HMAC keys (current, optional previous for rotation) and, only if requested,
 * the encryption key. Returns key objects; never prints them.
 */
export function loadIdentifierKeys(env = process.env, { requireEncryption = false } = {}) {
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
  }

  let encryption = null;
  const encText = readSecretText(env, 'EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY');
  if (encText || requireEncryption) {
    const keyId = String(env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID || '').trim();
    if (!keyId) throw new IdentifierCryptoError('KEY_ID_MISSING:EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID');
    encryption = {
      keyId,
      key: decodeBase64Key(encText, 'EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY', {
        exactBytes: ENCRYPTION_KEY_BYTES,
        minBytes: ENCRYPTION_KEY_BYTES,
      }),
    };
  }

  for (const hmac of [current, previous].filter(Boolean)) {
    if (encryption && hmac.key.length === encryption.key.length && timingSafeEqual(hmac.key, encryption.key)) {
      throw new IdentifierCryptoError('KEY_REUSE_HMAC_AND_ENCRYPTION');
    }
  }
  return { hmac: { current, previous }, encryption };
}

export function normalizeNationalId(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length === 13 ? digits : '';
}

function normalizeIdentifier(idType, rawValue) {
  if (!IDENTIFIER_TYPES.has(idType)) throw new IdentifierCryptoError('UNSUPPORTED_ID_TYPE');
  const normalized = normalizeNationalId(rawValue);
  if (!normalized) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
  return normalized;
}

/** HMAC-SHA-256 hex digest for exact lookup using one explicit key entry. */
export function identifierLookupHmac(idType, rawValue, hmacKeyEntry) {
  const value = normalizeIdentifier(idType, rawValue);
  if (!hmacKeyEntry?.key || !Number.isInteger(hmacKeyEntry.version)) {
    throw new IdentifierCryptoError('KEY_ENTRY_INVALID');
  }
  return createHmac('sha256', hmacKeyEntry.key)
    .update(`${LOOKUP_DOMAIN}\0${idType}\0${value}`, 'utf8')
    .digest('hex');
}

/** Lookup value to store: { lookup_hmac, key_version } using the current key. */
export function buildLookup(idType, rawValue, keys) {
  const entry = keys.hmac.current;
  return { lookup_hmac: identifierLookupHmac(idType, rawValue, entry), key_version: entry.version };
}

/** All candidate lookups (current + previous) so reads work during a rotation window. */
export function buildLookupCandidates(idType, rawValue, keys) {
  return [keys.hmac.current, keys.hmac.previous]
    .filter(Boolean)
    .map((entry) => ({ lookup_hmac: identifierLookupHmac(idType, rawValue, entry), key_version: entry.version }));
}

/**
 * AES-256-GCM envelope for the raw identifier. Requires an approved necessity reference
 * (ticket/decision id) — refuses otherwise so raw storage cannot happen by accident.
 */
export function encryptRawIdentifier(idType, rawValue, keys, { necessityApprovalRef } = {}) {
  if (!String(necessityApprovalRef || '').trim()) throw new IdentifierCryptoError('NECESSITY_APPROVAL_REQUIRED');
  if (!keys.encryption) throw new IdentifierCryptoError('ENCRYPTION_KEY_NOT_CONFIGURED');
  const value = normalizeIdentifier(idType, rawValue);
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

export function decryptRawIdentifier(envelope, keys) {
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

export function maskNationalId(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : '[redacted]';
}
