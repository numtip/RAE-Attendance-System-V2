const { randomBytes, createHash } = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * SSO login state store.
 *
 * Two known gaps this file previously had (recorded as G-02 in the shared standard's pilot gap
 * report), both addressed here:
 *
 *   1. NO BINDING. `create()` returned an opaque state with nothing tying it to the browser that
 *      started the login. V2 does not echo MJU `state` (see docs/SSO_PROTOCOL_EVIDENCE.md), so
 *      the state alone cannot distinguish "the user who started this" from "anyone holding it".
 *      `create({ binding })` now records a digest of a server-generated binding and
 *      `consume(state, binding)` refuses a callback that does not present it.
 *   2. IN-MEMORY ONLY. The map meant a restart forgot every pending login and a second instance
 *      never saw the first instance's state. The API is now ASYNC and takes an injectable
 *      `backend`, so a shared implementation (Redis/SQL) can be dropped in without touching the
 *      service layer. The in-memory backend remains the default for single-process use and says
 *      so honestly.
 *
 * Only digests are stored for the binding: the store cannot be read back into a usable cookie.
 *
 * BACKEND CONTRACT (a durable implementation must satisfy all of it — see
 * backend/tests/ssoStateStoreContract.test.js):
 *   get(key)          -> Promise<entry|undefined>
 *   set(key, entry)   -> Promise<void>            entry = { expiresAt, bindingDigest|null }
 *   delete(key)       -> Promise<void>
 *   keys()            -> Promise<string[]>        used only for pruning (optional)
 *   deleteMany(keys)  -> Promise<void>            optional; falls back to delete() in a loop
 *   kind              -> string, for diagnostics
 */

/** Default backend: one process, one memory. Not durable, not shared. */
function createInMemoryStateBackend({ now = () => Date.now(), maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const pending = new Map();
  return {
    kind: 'in-memory',
    durable: false,
    shared: false,
    async get(key) {
      const entry = pending.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        pending.delete(key);
        return undefined;
      }
      return entry;
    },
    async set(key, entry) {
      pending.set(key, entry);
      // Bound the map so an attacker cannot grow it without limit.
      while (pending.size > maxEntries) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
    },
    async delete(key) {
      pending.delete(key);
    },
    async keys() {
      return [...pending.keys()];
    },
    async size() {
      return pending.size;
    },
  };
}

function createSsoStateStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), backend } = {}) {
  const store = backend ?? createInMemoryStateBackend({ now });

  async function prune() {
    if (typeof store.keys !== 'function') return;
    const keys = await store.keys();
    const at = now();
    const stale = [];
    for (const key of keys) {
      const entry = await store.get(key);
      // get() already drops expired entries in the default backend; a durable backend may not.
      if (!entry || entry.expiresAt <= at) stale.push(key);
    }
    if (stale.length > 0) await removeMany(stale);
  }

  async function removeMany(keys) {
    if (typeof store.deleteMany === 'function') {
      await store.deleteMany(keys);
      return;
    }
    for (const key of keys) await store.delete(key);
  }

  return {
    /** Diagnostics only: no secret material. */
    kind: store.kind ?? 'custom',
    durable: store.durable === true,
    shared: store.shared === true,

    /**
     * Register a pending login.
     * @param {{binding?: string}} [options] server-generated browser binding (>= 16 chars)
     * @returns {Promise<string>} the opaque state value
     */
    async create(options = {}) {
      const { binding } = options;
      if (binding !== undefined && (typeof binding !== 'string' || binding.length < 16)) {
        // A weak binding is not a binding. Refuse rather than storing something guessable.
        throw new Error('binding must be a string of at least 16 characters');
      }
      await prune();
      const state = randomBytes(24).toString('hex');
      await store.set(state, {
        expiresAt: now() + ttlMs,
        bindingDigest: binding === undefined ? null : digest(binding),
      });
      return state;
    },

    /**
     * Consume a state exactly once.
     * @param {string} state
     * @param {string} [binding] required when the state was created with one
     * @returns {Promise<boolean>} true only for an unexpired, unconsumed, correctly bound state
     */
    async consume(state, binding) {
      if (!state || typeof state !== 'string') return false;
      const entry = await store.get(state);
      if (!entry) return false;

      // Burned on any attempt, valid or not: a second presentation can never succeed.
      await store.delete(state);

      if (entry.expiresAt <= now()) return false;
      if (entry.bindingDigest && entry.bindingDigest !== digest(binding ?? '')) return false;
      if (!entry.bindingDigest && binding !== undefined && binding !== '') {
        // A state created without a binding must not be satisfied by presenting one.
        return false;
      }
      return true;
    },

    /** Operational introspection: counts only. */
    async stats() {
      if (typeof store.size === 'function') return { pending: await store.size(), kind: store.kind };
      if (typeof store.keys === 'function') return { pending: (await store.keys()).length, kind: store.kind };
      return { pending: null, kind: store.kind };
    },
  };
}

module.exports = {
  createSsoStateStore,
  createInMemoryStateBackend,
  DEFAULT_TTL_MS,
};
