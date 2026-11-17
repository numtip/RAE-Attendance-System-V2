const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');

const DEFAULT_HANDOFF_TTL_MS = 45 * 1000;
const DEFAULT_MAX_HANDOFF_ENTRIES = 2_000;

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Single-use, short-lived, browser-bound handoff codes for delivering a server-minted SSO session
 * to the SPA without ever placing an access token, refresh token, `ac`, or PII in a URL.
 *
 * Security properties:
 *   - 45-second TTL by default.
 *   - Stored keyed by `sha256(code)` and bound to `sha256(browserBinding)` from an HttpOnly cookie.
 *   - Burned on the very first presentation regardless of outcome (expired or wrong binding cannot
 *     be retried).
 *   - Bounded capacity: refuses new codes rather than evicting unexpired ones.
 */
function createSsoLoginHandoffStore({
  ttlMs = DEFAULT_HANDOFF_TTL_MS,
  maxEntries = DEFAULT_MAX_HANDOFF_ENTRIES,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { expiresAt: number, bindingDigest: string|null, payload: object }>} */
  const pending = new Map();

  function prune() {
    const at = now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= at) {
        pending.delete(key);
      }
    }
  }

  return {
    issue(payload, { browserBinding } = {}) {
      if (!payload || typeof payload !== 'object') {
        throw new Error('handoff payload is required');
      }
      if (browserBinding !== undefined && (typeof browserBinding !== 'string' || browserBinding.length < 16)) {
        throw new Error('handoff browserBinding must be at least 16 characters');
      }
      prune();
      if (pending.size >= maxEntries) {
        throw new HttpError(503, 'SSO_HANDOFF_CAPACITY', 'Too many pending SSO handoffs');
      }
      const code = randomBytes(32).toString('base64url');
      pending.set(sha256Hex(code), {
        expiresAt: now() + ttlMs,
        bindingDigest: browserBinding ? sha256Hex(browserBinding) : null,
        payload,
      });
      return code;
    },

    /**
     * Consume a handoff code at most once.
     * @param {string} code
     * @param {string} [browserBinding]
     * @returns {{ status: 'ok', payload: object } | { status: 'missing'|'expired'|'binding_mismatch' }}
     */
    consume(code, browserBinding) {
      prune();
      if (typeof code !== 'string' || code.trim() === '') {
        return { status: 'missing' };
      }
      const key = sha256Hex(code.trim());
      const entry = pending.get(key);
      if (!entry) {
        return { status: 'missing' };
      }
      // Single-use whatever happens next.
      pending.delete(key);
      if (entry.expiresAt <= now()) {
        return { status: 'expired' };
      }
      if (entry.bindingDigest) {
        const presented =
          typeof browserBinding === 'string' && browserBinding !== '' ? sha256Hex(browserBinding) : null;
        if (!presented || !digestsEqual(entry.bindingDigest, presented)) {
          return { status: 'binding_mismatch' };
        }
      } else if (browserBinding !== undefined && browserBinding !== '') {
        return { status: 'binding_mismatch' };
      }
      return { status: 'ok', payload: entry.payload };
    },

    size() {
      prune();
      return pending.size;
    },
  };
}

module.exports = {
  createSsoLoginHandoffStore,
  DEFAULT_HANDOFF_TTL_MS,
  DEFAULT_MAX_HANDOFF_ENTRIES,
};
