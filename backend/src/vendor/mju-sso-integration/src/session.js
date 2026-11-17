import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * Session policy.
 *
 * The standard never stores a session in the browser. The browser holds an opaque
 * cookie; the server holds the session. No token, code or identity claim goes into
 * a cookie, localStorage or a query string.
 */

/** Cookie attributes for the session cookie. `secure` must stay true outside localhost. */
export const SESSION_COOKIE_POLICY = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  domain: undefined,
  // No maxAge/expires: a session cookie dies with the browser session, and the
  // server-side idle/absolute timeout is authoritative.
});

/** Attributes for the short-lived login-attempt binding cookie. */
export const ATTEMPT_COOKIE_POLICY = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  domain: undefined,
  maxAge: 10 * 60,
});

/**
 * Session fixation defence: the pre-login session id must never survive authentication.
 * A framework that cannot rotate must not be used with this adapter.
 *
 * @param {string|null|undefined} previousSessionId
 * @param {string|null|undefined} nextSessionId
 */
export function assertSessionRotated(previousSessionId, nextSessionId) {
  if (typeof nextSessionId !== 'string' || nextSessionId === '') {
    throw new SsoError(SSO_ERROR_CODES.SESSION_ROTATION, {
      status: 500,
      message: 'Authentication did not produce a session',
    });
  }
  if (previousSessionId && nextSessionId === previousSessionId) {
    throw new SsoError(SSO_ERROR_CODES.SESSION_ROTATION, {
      status: 500,
      message: 'Authentication did not rotate the session',
    });
  }
}

/**
 * Establish an authenticated session for an APPROVED local identity.
 * The caller supplies the framework hook; this function enforces the invariants.
 *
 * @param {{
 *   previousSessionId?: string|null,
 *   localUserId: string,
 *   correlationId?: string,
 *   issue: (input: {localUserId: string, correlationId?: string, previousSessionId?: string|null}) => Promise<{sessionId: string}> | {sessionId: string}
 * }} input
 */
export async function establishSession({ previousSessionId, localUserId, correlationId, issue }) {
  if (typeof localUserId !== 'string' || localUserId === '') {
    throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
      status: 403,
      message: 'No approved local identity is available',
    });
  }
  if (typeof issue !== 'function') {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A session issuer is required',
    });
  }
  const issued = await issue({ localUserId, correlationId, previousSessionId: previousSessionId ?? null });
  const sessionId = issued?.sessionId;
  assertSessionRotated(previousSessionId ?? null, sessionId);
  return { sessionId, localUserId };
}
