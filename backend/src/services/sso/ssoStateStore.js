const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function digestsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * SSO login state store.
 *
 * History: this was a bare in-memory Map with no browser binding (G-02). Two gaps were recorded
 * and are addressed here:
 *
 *   1. NO BINDING. `create()` returned an opaque state with nothing tying it to the browser that
 *      started the login. MJU does not echo `state` (docs/SSO_PROTOCOL_EVIDENCE.md), so the state
 *      alone cannot distinguish "the user who started this" from "anyone holding it".
 *      `create({ binding })` records a digest of a server-generated binding and
 *      `consume(state, binding)` refuses a callback that does not present it.
 *   2. IN-MEMORY ONLY. A restart forgot every pending login and a second instance never saw the
 *      first instance's state. The API is async and takes an injectable `backend`, so a shared
 *      implementation can be dropped in without touching the service layer.
 *
 * BACKEND CONTRACT. A backend supplies `get`/`set`/`delete`; everything else is optional:
 *   consume(key)   -> Promise<{status: 'ok'|'missing'|'expired', bindingDigest}>   PREFERRED.
 *                     Must remove the row atomically. When present, the store uses it instead of
 *                     a read-then-delete, which would let two concurrent callbacks both win.
 *   prune()        -> Promise<void>      expired-row housekeeping
 *   stats()        -> Promise<{pending}> diagnostics
 *   keys()         -> Promise<string[]>  legacy pruning path
 *   deleteMany(k)  -> Promise<void>
 *   size()         -> Promise<number>
 *   kind/durable/shared                  honest capability flags
 *
 * Keys are opaque strings. The store passes the state value through unchanged and never writes
 * it to a shared backend in plaintext — a persistent backend must digest it (see
 * mariadbLoginAttemptBackend.js).
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
    /** Atomic within one process: get + delete cannot interleave on the event loop boundary. */
    async consume(key) {
      const entry = pending.get(key);
      if (!entry) return { status: 'missing', bindingDigest: null };
      pending.delete(key);
      return {
        status: entry.expiresAt <= now() ? 'expired' : 'ok',
        bindingDigest: entry.bindingDigest ?? null,
      };
    },
    async prune() {
      const at = now();
      for (const [key, entry] of pending) {
        if (entry.expiresAt <= at) pending.delete(key);
      }
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

  if (typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function') {
    throw new Error('SSO state backend must implement get, set and delete');
  }

  async function prune() {
    if (typeof store.prune === 'function') {
      await store.prune();
      return;
    }
    if (typeof store.keys !== 'function') return;
    const at = now();
    const stale = [];
    for (const key of await store.keys()) {
      const entry = await store.get(key);
      if (!entry || entry.expiresAt <= at) stale.push(key);
    }
    if (stale.length === 0) return;
    if (typeof store.deleteMany === 'function') {
      await store.deleteMany(stale);
      return;
    }
    for (const key of stale) await store.delete(key);
  }

  async function removeAtomic(state) {
    if (typeof store.consume === 'function') {
      const result = await store.consume(state);
      return {
        status: result?.status ?? 'missing',
        bindingDigest: result?.bindingDigest ?? null,
      };
    }
    // Legacy backend without an atomic consume. Correct for a single process; a shared backend
    // must implement consume() or two concurrent callbacks can both succeed.
    const entry = await store.get(state);
    if (!entry) return { status: 'missing', bindingDigest: null };
    await store.delete(state);
    return {
      status: entry.expiresAt <= now() ? 'expired' : 'ok',
      bindingDigest: entry.bindingDigest ?? null,
    };
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

      const { status, bindingDigest } = await removeAtomic(state);
      // Removed on every presentation, valid or not: a second attempt can never succeed and a
      // wrong binding cannot be retried.
      if (status !== 'ok') return false;

      if (bindingDigest) {
        const presented = typeof binding === 'string' && binding !== '' ? digest(binding) : null;
        return presented !== null && digestsMatch(bindingDigest, presented);
      }
      // A state created without a binding must not be satisfied by presenting one.
      if (binding !== undefined && binding !== '') return false;
      return true;
    },

    /** Operational introspection: counts only. */
    async stats() {
      if (typeof store.stats === 'function') {
        const own = await store.stats();
        return { pending: own?.pending ?? null, kind: store.kind ?? 'custom' };
      }
      if (typeof store.size === 'function') return { pending: await store.size(), kind: store.kind };
      if (typeof store.keys === 'function') return { pending: (await store.keys()).length, kind: store.kind };
      return { pending: null, kind: store.kind ?? 'custom' };
    },
  };
}

module.exports = {
  createSsoStateStore,
  createInMemoryStateBackend,
  digest,
  DEFAULT_TTL_MS,
};
