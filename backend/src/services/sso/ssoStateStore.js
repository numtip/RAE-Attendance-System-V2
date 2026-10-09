const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/**
 * Single-use OAuth `state` values bound to the browser that started the login.
 *
 * The binding (a random value kept in an HttpOnly cookie by the controller) is stored only as a SHA-256 digest.
 * A callback that carries a valid `state` but not the matching binding is a login-CSRF attempt and is rejected;
 * the state is burned on any consume attempt, so it cannot be retried.
 *
 * In-memory: states do not survive a restart and are not shared between instances. Use a shared store before
 * running more than one backend instance.
 */
function createSsoStateStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
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
    /** @param {{ binding?: string }} [options] */
    create({ binding } = {}) {
      prune();
      const state = randomBytes(24).toString('hex');
      pending.set(state, {
        expiresAt: now() + ttlMs,
        bindingDigest: binding ? digest(binding) : null,
      });
      return state;
    },
    /**
     * @returns {boolean} false when the state is unknown, expired, already used, or not bound to the presenting browser.
     */
    consume(state, binding) {
      prune();
      if (typeof state !== 'string' || !pending.has(state)) {
        return false;
      }
      const entry = pending.get(state);
      pending.delete(state);
      if (entry.bindingDigest) {
        if (!binding || !timingSafeEqual(entry.bindingDigest, digest(binding))) {
          return false;
        }
      }
      return true;
    },
  };
}

module.exports = { createSsoStateStore };
