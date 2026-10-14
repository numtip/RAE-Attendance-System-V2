const { randomBytes } = require('node:crypto');

const DEFAULT_TTL_MS = 45 * 1000;

/**
 * Single-use opaque login handoff codes. Payload stays server-side (tokens never appear in URLs).
 */
function createSsoLoginCodeStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, { expiresAt: number, payload: object }>} */
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= t) {
        pending.delete(key);
      }
    }
  }

  return {
    issue(payload) {
      prune();
      const code = randomBytes(24).toString('hex');
      pending.set(code, { expiresAt: now() + ttlMs, payload });
      return code;
    },

    /**
     * Read a pending handoff without burning it. Used to show the candidate subject before confirm.
     * @returns {{ status: 'ok', payload: object } | { status: 'expired'|'unknown' }}
     */
    peek(code) {
      if (!code || !pending.has(code)) {
        return { status: 'unknown' };
      }
      const entry = pending.get(code);
      if (entry.expiresAt <= now()) {
        return { status: 'expired' };
      }
      return { status: 'ok', payload: entry.payload };
    },

    /**
     * @returns {{ status: 'ok', payload: object } | { status: 'expired'|'unknown' }}
     */
    consume(code) {
      if (!code || !pending.has(code)) {
        return { status: 'unknown' };
      }
      const entry = pending.get(code);
      pending.delete(code);
      if (entry.expiresAt <= now()) {
        return { status: 'expired' };
      }
      return { status: 'ok', payload: entry.payload };
    },
  };
}

module.exports = { createSsoLoginCodeStore, DEFAULT_TTL_MS };
