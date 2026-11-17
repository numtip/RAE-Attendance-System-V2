/**
 * Logging and redaction.
 *
 * A security log must be useful without being a second copy of the identity data.
 * Rules enforced here:
 *   - an identity document is never logged, in whole or in part
 *   - a callback code, token, cookie, authorization header or password is never logged
 *   - a citizen ID is never logged; masked last-4 at most, and only on request
 *   - a query string is stripped from any logged path
 *   - control characters are removed (log injection)
 */

/** Keys whose values are always replaced. Matched case-insensitively on substrings. */
const SENSITIVE_KEY_FRAGMENTS = Object.freeze([
  'ac',
  'code',
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'authorization',
  'auth',
  'session',
  'assertion',
  'citizenid',
  'citizen_id',
  'nationalid',
  'national_id',
  'humanid',
  'personid',
  'studentid',
  'personnelid',
  'email',
  'e_mail',
  'firstname',
  'lastname',
  'name',
  'picture',
  'photo',
  'jwt',
  'csrf',
  'state',
  'nonce',
  'signature',
]);

export const REDACTED = '[redacted]';

const MAX_VALUE_LENGTH = 200;
const MAX_DEPTH = 4;

/** Keys that are structural and must survive redaction even if a fragment matches. */
const SAFE_KEYS = Object.freeze(
  new Set([
    'event',
    'outcome',
    'code',
    'errorcode',
    'errormessage',
    'correlationid',
    'providerstatus',
    'method',
    'path',
    'actor',
    'reason',
    'level',
    'timestamp',
    'allow',
    'status',
    'version',
    'adapter',
    'capabilities',
    'counts',
    'providercertified',
    'items',
    'requirement',
    'id',
  ]),
);

/** @param {string} key */
export function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-.]/g, '_');
  const compact = normalized.replace(/_/g, '');
  // `ac` and `code` are short; require an exact-ish match to avoid redacting `cache`.
  if (normalized === 'ac' || normalized === 'code') return true;
  // Structural fields keep their names; their values are already safe by construction.
  if (SAFE_KEYS.has(compact)) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => compact.includes(fragment.replace(/_/g, '')));
}

/** Strip control characters and bound the length of anything that reaches a log sink. */
export function sanitizeLogValue(value) {
  if (value === null || value === undefined) return value;
  const raw = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : String(value);
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  return cleaned.length > MAX_VALUE_LENGTH ? `${cleaned.slice(0, MAX_VALUE_LENGTH)}...` : cleaned;
}

/**
 * Deep-redact an object. Unknown shapes are stringified, never spread.
 * @param {unknown} input
 * @param {number} [depth]
 */
export function redact(input, depth = 0) {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(input)) return input.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof input === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (value && typeof value === 'object') {
        out[key] = redact(value, depth + 1);
      } else {
        out[key] = sanitizeLogValue(value);
      }
    }
    return out;
  }
  return sanitizeLogValue(input);
}

/** Remove the query string (and fragment) from a path or URL before logging. */
export function stripQuery(pathOrUrl) {
  if (typeof pathOrUrl !== 'string') return '';
  const cut = pathOrUrl.search(/[?#]/);
  return sanitizeLogValue(cut === -1 ? pathOrUrl : pathOrUrl.slice(0, cut));
}

/**
 * Mask a national id: keep the last 4 digits only. Used for audit evidence, never
 * for identification, and never for a full value.
 * @param {string} value
 */
export function maskCitizenId(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 4) return REDACTED;
  return `*********${digits.slice(-4)}`;
}

const EVENT_FIELDS = Object.freeze([
  'event',
  'correlationId',
  'outcome',
  'errorCode',
  'providerStatus',
  'reason',
  'method',
  'path',
  'actor',
]);

/**
 * Build one structured log record. Only known fields survive; everything else is
 * redacted through `redact`.
 *
 * @param {{event: string, correlationId?: string, outcome?: string, errorCode?: string, providerStatus?: number, reason?: string, method?: string, path?: string, [key: string]: unknown}} input
 */
export function safeEvent(input = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level: input.outcome === 'failure' ? 'warn' : 'info',
  };
  for (const field of EVENT_FIELDS) {
    if (input[field] === undefined) continue;
    if (field === 'path') {
      record[field] = stripQuery(input[field]);
    } else if (typeof input[field] === 'number' || typeof input[field] === 'boolean') {
      record[field] = input[field];
    } else {
      record[field] = sanitizeLogValue(input[field]);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (EVENT_FIELDS.includes(key)) continue;
    record[key] = isSensitiveKey(key) ? REDACTED : value && typeof value === 'object' ? redact(value, 1) : sanitizeLogValue(value);
  }
  record.event = sanitizeLogValue(record.event);
  if (!record.event) record.event = 'unknown_event';
  return record;
}
