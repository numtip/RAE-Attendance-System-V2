import { createHash, randomBytes } from 'node:crypto';

import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { DEFAULT_ATTEMPT_TTL_MS, DEFAULT_CODE_TTL_MS, DEFAULT_MAX_ENTRIES } from './attemptStore.js';

/**
 * Attempt/code store backed by an external key-value service (Redis, SQL, DynamoDB, ...).
 *
 * Why this exists: `createMemoryAttemptStore` is single-process and dies on restart, so a
 * multi-process deployment loses pending logins and reopens the replay window. O-2 is that
 * decision. This file is the part that can be built without choosing a vendor (P-03): it takes a
 * driver and depends on nothing.
 *
 * WHAT THE DRIVER MUST PROVIDE, AND WHY EACH ONE IS ATOMIC
 * -------------------------------------------------------
 * A store of this kind is only worth having if two processes cannot both win the same decision.
 * Every primitive below is therefore required to be atomic *in the driver*; this module does not
 * and cannot implement atomicity on top of a non-atomic client.
 *
 *   setIfAbsent(key, value, ttlMs) -> Promise<boolean>     // Redis: SET key value NX EX ttl
 *                                                          // SQL:   INSERT ... ON CONFLICT DO NOTHING
 *   take(key)                      -> Promise<string|null> // Redis: GETDEL, or a Lua GET+DEL
 *                                                          // SQL:   DELETE ... RETURNING
 *   count(prefix)                  -> Promise<number>       // optional; enables the ceiling
 *
 * `take` must be atomic because `consume()` is single-use: a get-then-delete pair lets two
 * callbacks both read the binding before either deletes it, which defeats the point.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not claim the ceiling is enforced when the driver cannot count. Enforcing a ceiling on
 * a shared service means either a scan (O(n) per write) or a counter key that must itself be
 * atomic. Rather than pretend, `stats().ceilingEnforced` reports `false` and refusals stay at 0.
 * An operator who needs the ceiling must supply `count()`. A silent `true` would be the same class
 * of bug as a limiter that passes by evicting.
 */

/** @param {string} value */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{
 *   driver: {
 *     setIfAbsent: (key: string, value: string, ttlMs: number) => Promise<boolean>,
 *     take: (key: string) => Promise<string|null>,
 *     count?: (prefix: string) => Promise<number>,
 *   },
 *   keyPrefix?: string,
 *   attemptTtlMs?: number,
 *   codeTtlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 *   newBinding?: () => string,
 * }} options
 */
export function createSharedAttemptStore({
  driver,
  keyPrefix = 'mju-sso:',
  attemptTtlMs = DEFAULT_ATTEMPT_TTL_MS,
  codeTtlMs = DEFAULT_CODE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
  newBinding = () => randomBytes(32).toString('hex'),
} = {}) {
  if (!driver || typeof driver.setIfAbsent !== 'function' || typeof driver.take !== 'function') {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A shared attempt store needs a driver with setIfAbsent() and take()',
    });
  }
  const numbers = [['attemptTtlMs', attemptTtlMs], ['codeTtlMs', codeTtlMs], ['maxEntries', maxEntries]];
  for (const [name, value] of numbers) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 500,
        message: `A shared attempt store needs a positive integer ${name}`,
      });
    }
  }

  const attemptPrefix = `${keyPrefix}attempt:`;
  const codePrefix = `${keyPrefix}code:`;
  const ceilingEnforced = typeof driver.count === 'function';
  let refusedClaims = 0;

  /**
   * The stored value is `"<expiresAt>"` and nothing else. The digest is in the key, so a dump of
   * the store reveals neither a usable binding nor a usable code. The TTL is also handed to the
   * driver, so expiry is enforced by the service rather than by a sweep this module would run.
   */
  async function remember(prefix, keyDigest, ttlMs) {
    if (ceilingEnforced) {
      const size = await driver.count(prefix);
      if (size >= maxEntries) {
        refusedClaims += 1;
        return false;
      }
    }
    return driver.setIfAbsent(`${prefix}${keyDigest}`, String(now() + ttlMs), ttlMs);
  }

  return {
    kind: 'shared-attempt-store',
    // Exposed so a deployment can see what it actually guarantees, rather than assume.
    ceilingEnforced,

    /** Generated locally: a binding never needs to touch the network. */
    newBinding,

    /** @param {string} binding */
    async begin(binding) {
      if (typeof binding !== 'string' || binding.length < 16) {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A login attempt requires a server-generated binding',
        });
      }
      await remember(attemptPrefix, digest(binding), attemptTtlMs);
    },

    /**
     * Single-use, burned on any attempt.
     * @param {string|undefined} binding
     * @returns {Promise<'ok'|'missing'|'expired'>}
     */
    async consume(binding) {
      if (typeof binding !== 'string' || binding === '') return 'missing';
      const stored = await driver.take(`${attemptPrefix}${digest(binding)}`);
      if (stored === null || stored === undefined) return 'missing';
      // The driver's TTL should already have removed it. This is the belt to that braces and
      // matters when a driver treats a TTL as advisory rather than as a guarantee.
      const expiresAt = Number(stored);
      if (!Number.isFinite(expiresAt)) return 'missing';
      return expiresAt <= now() ? 'expired' : 'ok';
    },

    /**
     * @param {string} code
     * @returns {Promise<boolean>} false when already seen, or refused at the ceiling
     */
    async claimCode(code) {
      if (typeof code !== 'string' || code === '') {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A code claim requires a non-empty code',
        });
      }
      return remember(codePrefix, digest(code), codeTtlMs);
    },

    /** Counts and verdicts only; never a binding, a code or a digest. */
    async stats() {
      const pendingAttempts = ceilingEnforced ? await driver.count(attemptPrefix) : null;
      const seenCodes = ceilingEnforced ? await driver.count(codePrefix) : null;
      return { pendingAttempts, seenCodes, refusedClaims, ceilingEnforced };
    },
  };
}

/**
 * An in-process driver that implements the contract faithfully, so the shared store can be tested
 * without a service. It is NOT a production driver: it lives in one process, which is the very
 * limitation O-2 exists to remove.
 *
 * It is useful for proving the shared store's own logic against the same conformance suite as the
 * memory store, and as the reference for what a Redis or SQL driver has to do.
 *
 * @param {{ttlClock?: () => number}} [options] `ttlClock` replaces wall time so expiry is testable.
 */
export function createReferenceDriver({ ttlClock } = {}) {
  /** @type {Map<string, {value: string, expiresAt: number}>} */
  const data = new Map();
  const clock = ttlClock ?? (() => Date.now());

  function alive(key) {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= clock()) {
      data.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async setIfAbsent(key, value, ttlMs) {
      if (alive(key)) return false;
      data.set(key, { value, expiresAt: clock() + ttlMs });
      return true;
    },
    async take(key) {
      const entry = alive(key);
      if (!entry) return null;
      data.delete(key);
      return entry.value;
    },
    async count(prefix) {
      let total = 0;
      for (const key of [...data.keys()]) {
        if (!alive(key)) continue;
        if (key.startsWith(prefix)) total += 1;
      }
      return total;
    },
  };
}
