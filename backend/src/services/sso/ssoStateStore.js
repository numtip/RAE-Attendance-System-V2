const { randomBytes } = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

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
    create() {
      prune();
      const state = randomBytes(24).toString('hex');
      pending.set(state, { expiresAt: now() + ttlMs });
      return state;
    },
    consume(state) {
      prune();
      if (!state || !pending.has(state)) {
        return false;
      }
      pending.delete(state);
      return true;
    },
  };
}

module.exports = { createSsoStateStore };
