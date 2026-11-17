import { randomBytes } from 'node:crypto';

import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { createCsrfToken } from './csrf.js';

/**
 * The session store interface, in its in-memory form.
 *
 * This is the reference implementation of the shape a deployment must provide — `issue`, `read`,
 * `revoke`, `size` — and it is deliberately the one that does NOT survive a restart. It exists so
 * tests and a single-process development run need no service, and it is the interface the durable
 * implementation (`createDurableSessionStore`) has to satisfy.
 *
 * `read` is synchronous here and awaitable in the durable implementation; callers must `await` it,
 * which is a no-op for a plain value. That is the whole trick that lets one call site serve both.
 *
 * A session record is `{ localUserId, csrfToken, expiresAt }`. `localUserId` is this application's
 * own label, never a provider subject and never a national identifier.
 */

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * @param {{
 *   ttlMs?: number,
 *   now?: () => number,
 *   newSessionId?: () => string,
 *   newCsrfToken?: () => string,
 * }} [options]
 */
export function createMemorySessionStore({
  ttlMs = DEFAULT_SESSION_TTL_MS,
  now = () => Date.now(),
  newSessionId = () => randomBytes(32).toString('hex'),
  newCsrfToken = createCsrfToken,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A session store needs a positive integer ttlMs',
    });
  }

  /** @type {Map<string, {localUserId: string, csrfToken: string, expiresAt: number}>} */
  const sessions = new Map();

  function sweep() {
    const at = now();
    for (const [id, session] of sessions) if (session.expiresAt <= at) sessions.delete(id);
  }

  return {
    kind: 'memory-session-store',
    durable: false,

    issue({ localUserId } = {}) {
      if (typeof localUserId !== 'string' || localUserId === '') {
        throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
          status: 403,
          message: 'No approved local identity is available',
        });
      }
      sweep();
      const sessionId = newSessionId();
      sessions.set(sessionId, { localUserId, csrfToken: newCsrfToken(), expiresAt: now() + ttlMs });
      return { sessionId };
    },

    read(sessionId) {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || session.expiresAt <= now()) return null;
      return { sessionId, ...session };
    },

    revoke({ sessionId } = {}) {
      return sessions.delete(sessionId);
    },

    get size() {
      return sessions.size;
    },

    close() {
      // Nothing to close.
    },
  };
}
