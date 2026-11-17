import { createHash, randomBytes } from 'node:crypto';
import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * Login-attempt and code-replay store.
 *
 * MJU does not echo `state` (contract C-10, negative evidence), so a callback cannot
 * be tied to the exact authorization request. The compensations this store provides:
 *
 *   1. Browser binding — `/login` registers a random binding and sets it as an HttpOnly
 *      cookie. The callback must present it, it is single-use, and it expires. A callback
 *      pasted into a browser that never started a login here is refused before the
 *      provider is contacted. Residual risk: inside a browser that *did* just start a
 *      login, an attacker-supplied callback cannot be distinguished from the provider's.
 *      That residual risk is a documented BLOCKER, not something this store closes.
 *   2. Code replay — each `ac` is tried at most once. MJU's own single-use rule is
 *      UNKNOWN (C-04), so the standard does not depend on it.
 *
 * Only SHA-256 digests are retained: the store cannot be read back into usable cookies
 * or codes, and there is no plaintext secret in memory.
 *
 * IMPORTANT: the in-memory implementation is for a single process and does not survive
 * a restart. Production requires a shared implementation (Redis/SQL) of the SAME
 * interface; `tests/attemptStore.contract.test.js` is the conformance suite for that.
 *
 * `maxEntries` bounds memory. When a map is full the store REFUSES the new attempt or code
 * instead of evicting a live one: forgetting a used code inside its window would allow it to
 * be replayed. Refusal fails closed — a refused attempt can never authenticate — and is
 * visible in `stats().refusedClaims`.
 */

export const DEFAULT_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CODE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 10_000;

/** @param {string} value */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{attemptTtlMs?: number, codeTtlMs?: number, maxEntries?: number, now?: () => number, newBinding?: () => string}} [options]
 */
export function createMemoryAttemptStore({
  attemptTtlMs = DEFAULT_ATTEMPT_TTL_MS,
  codeTtlMs = DEFAULT_CODE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
  newBinding = () => randomBytes(32).toString('hex'),
} = {}) {
  /** @type {Map<string, number>} digest(binding) -> expiresAt */
  const attempts = new Map();
  /** @type {Map<string, number>} digest(code) -> expiresAt */
  const codes = new Map();
  let refusedClaims = 0;

  /**
   * Delete only entries whose own TTL has passed.
   *
   * A live entry is never removed to make room. Dropping a code that is still inside its
   * window would forget that it was already used, which reopens exactly the replay the
   * store exists to refuse.
   */
  function prune(map) {
    const at = now();
    for (const [key, expiresAt] of map) {
      if (expiresAt <= at) map.delete(key);
    }
  }

  /**
   * Remember a claim when there is room, and refuse it when there is not.
   *
   * A refused claim is not stored, so presenting it later cannot succeed: the login or the
   * callback fails closed instead of displacing an entry that is still in force. Under
   * sustained pressure this denies new logins (bounded availability) rather than accepting
   * a replayed code (integrity), which is the direction the standard fails in.
   */
  function remember(map, key, expiresAt) {
    if (map.size >= maxEntries) {
      refusedClaims += 1;
      return false;
    }
    map.set(key, expiresAt);
    return true;
  }

  return {
    kind: 'memory-attempt-store',

    newBinding,

    /** @param {string} binding */
    begin(binding) {
      if (typeof binding !== 'string' || binding.length < 16) {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A login attempt requires a server-generated binding',
        });
      }
      prune(attempts);
      remember(attempts, digest(binding), now() + attemptTtlMs);
    },

    /**
     * Single-use. Burned on any attempt, valid or not.
     * @param {string|undefined} binding
     * @returns {'ok'|'missing'|'expired'}
     */
    consume(binding) {
      prune(attempts);
      if (typeof binding !== 'string' || binding === '') return 'missing';
      const key = digest(binding);
      const expiresAt = attempts.get(key);
      if (expiresAt === undefined) return 'missing';
      attempts.delete(key);
      return expiresAt <= now() ? 'expired' : 'ok';
    },

    /**
     * Mark a callback code as seen. Returns false if it was already claimed.
     * @param {string} code
     */
    claimCode(code) {
      prune(codes);
      const key = digest(code);
      if (codes.has(key)) return false;
      return remember(codes, key, now() + codeTtlMs);
    },

    /** Operational introspection (no secrets, counts only). */
    stats() {
      prune(attempts);
      prune(codes);
      return { pendingAttempts: attempts.size, seenCodes: codes.size, refusedClaims };
    },
  };
}
