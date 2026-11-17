import { createHash, randomBytes } from 'node:crypto';

import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { createCsrfToken } from './csrf.js';
import { DEFAULT_SESSION_TTL_MS } from './sessionStore.js';

/**
 * Durable session store: the same interface as `createMemorySessionStore`, over an external driver.
 *
 * WHAT THE DRIVER MUST PROVIDE
 * ---------------------------
 *   setIfAbsent(key, value, ttlMs) -> Promise<boolean>   atomic create, server-side expiry
 *   get(key)                       -> Promise<string|null>
 *   take(key)                      -> Promise<string|null>   atomic get+delete
 *   count?(prefix)                 -> Promise<number>
 *
 * `take` is what makes revocation single-use. A get-then-delete pair would let two concurrent
 * logouts both report that they destroyed the session; `rename()` or `GETDEL` lets exactly one.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * -------------------------------
 * The key is `sha256(sessionId)`, so a dump of the store does not contain a usable cookie value.
 * The value is the record `{ localUserId, csrfToken, expiresAt }`:
 *   - `localUserId` is this application's own label — not a provider subject, not a national id;
 *   - `csrfToken` has to be reproducible, because it is rendered into the logout form. It is a
 *     session-scoped secret and its presence in the record is a real (documented) limitation: a
 *     read-only copy of the store yields a usable CSRF token for a live session, though still not
 *     the session id it belongs to. Deriving it from a server key instead would remove that, and is
 *     left to a decision that changes `issue()`'s contract;
 *   - `expiresAt` is the second expiry check. The driver's TTL is the first, and the authoritative
 *     one when the server is honest; the stored value is what catches a driver that treats a TTL as
 *     advisory.
 *
 * A session is minted ONLY after the store has accepted the record: if `setIfAbsent` throws, so does
 * `issue`, and the caller gets no session id. There is no in-memory fallback anywhere in this file.
 */

/** @param {string} value */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{
 *   driver: {
 *     setIfAbsent: (key: string, value: string, ttlMs: number) => Promise<boolean>,
 *     get: (key: string) => Promise<string|null>,
 *     take: (key: string) => Promise<string|null>,
 *   },
 *   ttlMs?: number,
 *   keyPrefix?: string,
 *   now?: () => number,
 *   newSessionId?: () => string,
 *   newCsrfToken?: () => string,
 * }} options
 */
export function createDurableSessionStore({
  driver,
  ttlMs = DEFAULT_SESSION_TTL_MS,
  keyPrefix = 'mju-sso:',
  now = () => Date.now(),
  newSessionId = () => randomBytes(32).toString('hex'),
  newCsrfToken = createCsrfToken,
} = {}) {
  if (
    !driver ||
    typeof driver.setIfAbsent !== 'function' ||
    typeof driver.get !== 'function' ||
    typeof driver.take !== 'function'
  ) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A durable session store needs a driver with setIfAbsent(), get() and take()',
    });
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A session store needs a positive integer ttlMs',
    });
  }

  const sessionPrefix = `${keyPrefix}sess:`;
  const keyFor = (sessionId) => `${sessionPrefix}${digest(sessionId)}`;

  async function revokeOnce({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const taken = await driver.take(keyFor(sessionId));
    return taken !== null && taken !== undefined;
  }

  return {
    kind: 'durable-session-store',
    durable: true,

    /**
     * Mint a session. The id is generated locally and stored before it is returned, so a store that
     * refuses the write produces no session at all.
     *
     * @param {{localUserId?: string, correlationId?: string, previousSessionId?: string|null}} input
     * @returns {Promise<{sessionId: string}>}
     */
    async issue({ localUserId, previousSessionId } = {}) {
      if (typeof localUserId !== 'string' || localUserId === '') {
        throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
          status: 403,
          message: 'No approved local identity is available',
        });
      }

      let sessionId = null;
      for (let attempt = 0; attempt < 3 && sessionId === null; attempt += 1) {
        const candidate = newSessionId();
        const record = JSON.stringify({
          localUserId,
          csrfToken: newCsrfToken(),
          expiresAt: now() + ttlMs,
        });
        // `true` means this process created the key. `false` is a collision (or a live record at the
        // same digest), never a licence to reuse one: try a different id.
        if (await driver.setIfAbsent(keyFor(candidate), record, ttlMs)) sessionId = candidate;
      }
      if (sessionId === null) {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A unique session id could not be allocated',
        });
      }

      // Rotation. The pre-login id must not survive authentication (assertSessionRotated enforces the
      // caller side); the old record is destroyed here. A failure to do so throws, and the new id is
      // never returned, so the caller cannot end up holding a session while the old one lives.
      if (typeof previousSessionId === 'string' && previousSessionId !== '') {
        await revokeOnce({ sessionId: previousSessionId });
      }

      return { sessionId };
    },

    /**
     * @param {string|undefined} sessionId
     * @returns {Promise<{sessionId: string, localUserId: string, csrfToken: string, expiresAt: number}|null>}
     */
    async read(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const raw = await driver.get(keyFor(sessionId));
      if (typeof raw !== 'string' || raw === '') return null;

      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!record || typeof record !== 'object') return null;
      if (typeof record.localUserId !== 'string' || record.localUserId === '') return null;
      if (typeof record.csrfToken !== 'string' || record.csrfToken === '') return null;
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now()) {
        // Belt to the driver's TTL. Best effort: the answer is already "no session", and a failure
        // to tidy the dead record must not turn into a session.
        try {
          await driver.take(keyFor(sessionId));
        } catch {
          // Ignored on purpose; see above.
        }
        return null;
      }
      return {
        sessionId,
        localUserId: record.localUserId,
        csrfToken: record.csrfToken,
        expiresAt: record.expiresAt,
      };
    },

    /**
     * Destroy a session. Atomic: of N concurrent revocations of one id, exactly one `revokeOnce`
     * reports `true`. `revoke` is the interface method and does not report; it is not a licence to
     * ignore the result where the result matters.
     *
     * @param {{sessionId?: string}} input
     */
    async revoke({ sessionId } = {}) {
      await revokeOnce({ sessionId });
    },

    /** @param {{sessionId?: string}} input @returns {Promise<boolean>} true when this call destroyed it */
    revokeOnce,

    /**
     * The number of live sessions is NOT knowable without an O(n) scan, so it is reported as
     * unknown rather than guessed. `/healthz` renders this as `null`, which an operator reads as
     * "ask the store", not as "zero sessions".
     */
    get size() {
      return null;
    },

    close() {
      if (typeof driver.close === 'function') driver.close();
    },
  };
}
