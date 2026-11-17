import { createHash } from 'node:crypto';

import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * Login / callback rate limiter.
 *
 * A framework layer knows the caller's address; the adapter does not, and deliberately never
 * reads headers. So this is a standalone guard a consumer applies at the two entry points the
 * standard defines — `beginLogin` and `handleCallback` — with whatever key it can justify
 * (peer address, a derived per-user key). Nothing here authenticates anybody: a limiter that
 * fails open would be a bypass, so this one fails closed at its own ceiling.
 *
 * Two properties matter and are both tested:
 *   1. A refused key is refused, and the refusal carries how long to wait. It never silently
 *      allows "one more" request.
 *   2. The bucket table is bounded. Keys are stored as SHA-256 digests, so the table cannot be
 *      read back into the addresses that produced it, and when the ceiling is reached the new
 *      key is refused rather than an active bucket being evicted (evicting would reset a
 *      counter that is mid-limit).
 *
 * This is a single-process guard. A multi-process deployment needs a shared implementation of
 * the same interface (the same shape as `createMemoryAttemptStore`).
 */

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_RATE_LIMIT_MAX = 20;
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

/** @param {string} value */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{max?: number, windowMs?: number, maxKeys?: number, now?: () => number}} [options]
 */
export function createRateLimiter({
  max = DEFAULT_RATE_LIMIT_MAX,
  windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  maxKeys = DEFAULT_RATE_LIMIT_MAX_KEYS,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of [['max', max], ['windowMs', windowMs], ['maxKeys', maxKeys]]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 500,
        message: `A rate limiter needs a positive integer ${name}`,
      });
    }
  }

  /** @type {Map<string, {count: number, resetAt: number}>} digest(key) -> bucket */
  const buckets = new Map();
  let refusals = 0;

  function prune() {
    const at = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  return {
    kind: 'memory-rate-limiter',
    max,
    windowMs,

    /**
     * Count one attempt for `key`.
     *
     * @param {string} key stable, non-secret caller identifier (hashed before storage)
     * @returns {{allowed: boolean, remaining: number, retryAfterMs: number, resetAt: number}}
     */
    check(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A rate limiter requires a non-empty key',
        });
      }
      const at = now();
      prune();
      const keyDigest = digest(key);
      const bucket = buckets.get(keyDigest);

      if (bucket) {
        if (bucket.count >= max) {
          refusals += 1;
          return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - at, resetAt: bucket.resetAt };
        }
        bucket.count += 1;
        return {
          allowed: true,
          remaining: max - bucket.count,
          retryAfterMs: 0,
          resetAt: bucket.resetAt,
        };
      }

      // At the ceiling: refuse rather than evict a bucket that is mid-limit. Evicting would
      // hand the evicted key a fresh window, which is the bypass this guard exists to stop.
      if (buckets.size >= maxKeys) {
        refusals += 1;
        return { allowed: false, remaining: 0, retryAfterMs: windowMs, resetAt: at + windowMs };
      }

      const resetAt = at + windowMs;
      buckets.set(keyDigest, { count: 1, resetAt });
      return { allowed: true, remaining: max - 1, retryAfterMs: 0, resetAt };
    },

    /** Forget one key (e.g. after a successful sign-in). */
    forget(key) {
      if (typeof key !== 'string' || key.length === 0) return false;
      return buckets.delete(digest(key));
    },

    /** Operational introspection: counts only, never a key. */
    stats() {
      prune();
      return { trackedKeys: buckets.size, refusals };
    },
  };
}

/**
 * Apply a limiter decision, or throw the refusal as an `SsoError`.
 *
 * `SSO_RATE_LIMITED` carries `Retry-After` in whole seconds, rounded up so a client never
 * retries early. A refused attempt must not reach `beginLogin`/`handleCallback`.
 *
 * @param {{allowed: boolean, retryAfterMs: number}} decision
 */
export function assertWithinLimit(decision) {
  if (decision?.allowed === true) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((decision?.retryAfterMs ?? 0) / 1000));
  throw new SsoError(SSO_ERROR_CODES.RATE_LIMITED, {
    status: 429,
    message: 'Too many sign-in attempts',
    details: { retryAfterSeconds },
  });
}
