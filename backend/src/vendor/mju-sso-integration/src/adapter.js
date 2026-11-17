import { SsoError, SSO_ERROR_CODES, toPublicError } from './errors.js';
import {
  AC_PATTERN,
  CONTRACT_OVERALL_STATUS,
  CONTRACT_STATUS,
  assertProviderConfig,
  buildSigninUrl,
  buildSignoutUrl,
  contractSummary,
  contractItemStatus,
} from './contract.js';
import { createTokenClient } from './tokenClient.js';
import { normalizeIdentityAssertion } from './identity.js';
import { deriveSubjectKey } from './identityMapping.js';
import { createMemoryAttemptStore } from './attemptStore.js';
import { assertCallbackMethod, assertLogoutMethod, verifyCsrf } from './csrf.js';
import { ATTEMPT_COOKIE_POLICY, SESSION_COOKIE_POLICY, establishSession } from './session.js';
import { safeEvent } from './redact.js';

export const ADAPTER_NAME = 'mju-sso-adapter';
/** Bumped when adapter behaviour changes in a way a consumer must know about. */
export const ADAPTER_VERSION = '1.0.0-rc.6';
export const ATTEMPT_COOKIE = 'mju_sso_attempt';
export const SESSION_COOKIE = 'mju_sso_session';

const LOCAL_IDENTITY_APPROVED = 'approved';

/**
 * Framework-independent adapter.
 *
 * It returns plain response descriptions — `{status, redirectTo, cookies}` — and
 * never touches an HTTP framework. A thin glue layer (Express, Fastify, ASP.NET,
 * Laravel, ...) maps those to its own response object. This is what makes the
 * standard reusable without copying security logic per stack.
 *
 * Anything that would issue a session fails closed unless:
 *   1. the provider config is structurally valid and allowlisted,
 *   2. the callback is bound to a login attempt this browser started (single use),
 *   3. the code has never been seen,
 *   4. the exchange yields a structurally usable candidate subject,
 *   5. that subject resolves to an APPROVED local identity.
 *
 * "citizenID is present" satisfies none of 1-5.
 *
 * @param {{
 *   config?: {
 *     enabled?: boolean,
 *     allowUnverifiedContract?: boolean,
 *     clientId?: string,
 *     signinUrl?: string,
 *     signoutUrl?: string,
 *     tokenUrl?: string,
 *     allowedHosts?: readonly string[],
 *     requireHttps?: boolean,
 *     postLoginRedirect?: string,
 *     contractStatus?: string,
 *   },
 *   deps?: {
 *     tokenClient?: ReturnType<typeof createTokenClient>,
 *     attemptStore?: ReturnType<typeof createMemoryAttemptStore>,
 *     identityResolver?: (input: {provider: string, subject: string}) => Promise<{status: string, localUserId?: string}> | {status: string, localUserId?: string},
 *     sessionManager?: {
 *       issue: (input: {localUserId: string, correlationId?: string, previousSessionId?: string|null}) => Promise<{sessionId: string}> | {sessionId: string},
 *       revoke: (input: {sessionId: string, correlationId?: string}) => Promise<void> | void,
 *     },
 *     logger?: (record: Record<string, unknown>) => void,
 *     fetchImpl?: typeof fetch,
 *   }
 * }} [options]
 */
export function createMjuSsoAdapter({ config = {}, deps = {} } = {}) {
  const settings = {
    enabled: config.enabled === true,
    allowUnverifiedContract: config.allowUnverifiedContract === true,
    clientId: config.clientId,
    signinUrl: config.signinUrl,
    signoutUrl: config.signoutUrl,
    tokenUrl: config.tokenUrl,
    allowedHosts: config.allowedHosts,
    requireHttps: config.requireHttps !== false,
    postLoginRedirect: config.postLoginRedirect ?? '/',
    contractStatus: config.contractStatus ?? CONTRACT_OVERALL_STATUS,
    lawfulBasisApproved: config.lawfulBasisApproved === true,
    hmacKey: typeof config.hmacKey === 'string' ? config.hmacKey : '',
    appId: typeof config.appId === 'string' && config.appId !== '' ? config.appId : undefined,
    // Optional. Setting it selects ONE candidate claim; leaving it unset requires every
    // present candidate claim to agree (the vendor sample's humanID/personID do not).
    subjectClaim: config.subjectClaim,
  };

  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  const attemptStore = deps.attemptStore ?? createMemoryAttemptStore();
  // The token client must honour the SAME trust settings as the rest of the adapter. Previously
  // it was constructed with defaults, so a deployment that allowlisted a local/staging host and
  // relaxed https for a test could still not exchange — a silently divergent policy.
  const tokenClient =
    deps.tokenClient ??
    createTokenClient({
      fetchImpl: deps.fetchImpl,
      allowedHosts: settings.allowedHosts,
      requireHttps: settings.requireHttps,
    });
  const identityResolver = deps.identityResolver;
  const sessionManager = deps.sessionManager;

  function log(record) {
    try {
      logger(safeEvent(record));
    } catch {
      // A logging failure must never change an authentication outcome.
    }
  }

  /**
   * Fail closed until an operator makes the contract state explicit.
   * An unverified contract may only be exercised by a deployment that has *said*
   * it is exercising an unverified contract (staging / mock QA).
   */
  function assertReady() {
    if (!settings.enabled) {
      throw new SsoError(SSO_ERROR_CODES.DISABLED, {
        status: 403,
        message: 'MJU SSO is disabled for this deployment',
      });
    }
    if (settings.contractStatus !== CONTRACT_STATUS.VERIFIED && settings.allowUnverifiedContract !== true) {
      throw new SsoError(SSO_ERROR_CODES.NOT_READY, {
        status: 503,
        message: 'The MJU SSO provider contract is not verified',
        details: { contractStatus: settings.contractStatus },
      });
    }
    assertProviderConfig({
      clientId: settings.clientId,
      signinUrl: settings.signinUrl,
      signoutUrl: settings.signoutUrl,
      tokenUrl: settings.tokenUrl,
      allowedHosts: settings.allowedHosts,
      requireHttps: settings.requireHttps,
    });
  }

  async function run(event, correlationId, fn) {
    try {
      const result = await fn();
      log({ event, correlationId, outcome: 'success' });
      return result;
    } catch (error) {
      const publicError = toPublicError(error);
      log({
        event,
        correlationId,
        outcome: 'failure',
        errorCode: publicError.code,
        ...(publicError.details?.providerStatus ? { providerStatus: publicError.details.providerStatus } : {}),
      });
      throw error;
    }
  }

  /**
   * The value a resolver is allowed to see.
   *
   * For an opaque claim that is the assertion's subject. For a confidential claim (`citizenID`) the
   * raw national id never leaves this function: it is replaced by the application-scoped HMAC, so a
   * resolver, a database or a log downstream can only ever hold a pseudonym.
   *
   * @param {object} assertion
   * @returns {{subject: string, subjectIsConfidential: boolean}}
   */
  function resolverSubject(assertion) {
    if (assertion.subjectIsConfidential !== true) {
      return { subject: assertion.subject, subjectIsConfidential: false };
    }
    if (typeof settings.hmacKey !== 'string' || settings.hmacKey === '') {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 503,
        message: 'A confidential subject requires a configured HMAC key',
        details: { subjectClaim: assertion.subjectClaim },
      });
    }
    return {
      subject: deriveSubjectKey({
        appId: settings.appId ?? 'mju-sso-consumer',
        provider: assertion.provider,
        subject: assertion.subject,
        hmacKey: settings.hmacKey,
      }),
      subjectIsConfidential: true,
    };
  }

  async function resolveLocalIdentity(assertion) {
    if (typeof identityResolver !== 'function') {
      throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
        status: 403,
        message: 'No local identity resolver is configured',
      });
    }
    const material = resolverSubject(assertion);
    const resolved = await identityResolver({
      provider: assertion.provider,
      subject: material.subject,
      subjectClaim: assertion.subjectClaim,
      subjectIsConfidential: material.subjectIsConfidential,
    });
    const status = resolved?.status;
    if (status === LOCAL_IDENTITY_APPROVED) {
      if (typeof resolved.localUserId !== 'string' || resolved.localUserId === '') {
        throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
          status: 403,
          message: 'The approved identity has no local user',
        });
      }
      return { status, localUserId: resolved.localUserId };
    }
    if (status === 'conflict') {
      throw new SsoError(SSO_ERROR_CODES.IDENTITY_CONFLICT, {
        status: 409,
        message: 'The provider subject is already linked to another identity',
      });
    }
    if (status === 'disabled') {
      throw new SsoError(SSO_ERROR_CODES.IDENTITY_DISABLED, { status: 403, message: 'This account is not active' });
    }
    if (status === 'pending' || status === 'candidate' || status === 'revoked') {
      throw new SsoError(SSO_ERROR_CODES.IDENTITY_NOT_APPROVED, {
        status: 403,
        message: 'This identity is not approved for sign-in',
      });
    }
    throw new SsoError(SSO_ERROR_CODES.IDENTITY_UNLINKED, {
      status: 403,
      message: 'No approved local identity matches this provider identity',
    });
  }

  return {
    name: ADAPTER_NAME,
    version: ADAPTER_VERSION,

    manifest() {
      return {
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        contract: contractSummary(),
        capabilities: {
          loginRedirect: true,
          callbackExchange: true,
          sessionIssuance: Boolean(sessionManager?.issue),
          logout: true,
          providerStateEcho: false,
          providerResponseSignature: false,
        },
        // Read by consumers and by the adoption checklist. Never flip this by config.
        providerCertified: false,
      };
    },

    /**
     * Start a login. Returns a redirect plus the attempt cookie to set.
     * No user-supplied redirect target is accepted.
     */
    async beginLogin({ correlationId } = {}) {
      return run('sso_login_started', correlationId, async () => {
        assertReady();
        const binding = attemptStore.newBinding();
        // Awaited so either store can be plugged in: `await` on the synchronous memory store
        // returns its value unchanged, and a network-backed store can be asynchronous. Without
        // this, O-2 would need a breaking change to every consumer.
        await attemptStore.begin(binding);
        const redirectTo = buildSigninUrl({
          signinUrl: settings.signinUrl,
          clientId: settings.clientId,
          allowedHosts: settings.allowedHosts,
          requireHttps: settings.requireHttps,
        });
        return {
          status: 302,
          redirectTo,
          correlationId,
          cookies: [{ name: ATTEMPT_COOKIE, value: binding, ...ATTEMPT_COOKIE_POLICY }],
        };
      });
    },

    /**
     * Handle the provider redirect.
     * @param {{
     *   method?: string,
     *   query?: Record<string, unknown>,
     *   cookies?: Record<string, string>,
     *   previousSessionId?: string|null,
     *   correlationId?: string,
     * }} input
     */
    async handleCallback({ method = 'GET', query = {}, cookies = {}, previousSessionId = null, correlationId } = {}) {
      return run('sso_callback', correlationId, async () => {
        const clearAttemptCookie = { name: ATTEMPT_COOKIE, value: '', ...ATTEMPT_COOKIE_POLICY, maxAge: 0 };

        // 1. Transport shape before anything else.
        assertCallbackMethod(method);
        assertReady();

        const raw = query?.ac;
        if (Array.isArray(raw)) {
          throw new SsoError(SSO_ERROR_CODES.CALLBACK_DUPLICATE, {
            status: 400,
            message: 'The callback contains more than one login code',
          });
        }
        if (query?.error !== undefined) {
          throw new SsoError(SSO_ERROR_CODES.CODE_REJECTED, {
            status: 401,
            message: 'The provider reported a failed sign-in',
          });
        }

        // 2. Bind to a login this browser started. Burned whatever happens next.
        const binding = cookies?.[ATTEMPT_COOKIE];
        const attempt = await attemptStore.consume(binding);
        if (attempt === 'expired') {
          throw new SsoError(SSO_ERROR_CODES.ATTEMPT_EXPIRED, {
            status: 403,
            message: 'The sign-in attempt expired',
          });
        }
        if (attempt !== 'ok') {
          throw new SsoError(SSO_ERROR_CODES.ATTEMPT_MISSING, {
            status: 403,
            message: 'Sign-in was not started in this browser',
          });
        }

        // 3. Shape of the code, then replay.
        if (typeof raw !== 'string' || !AC_PATTERN.test(raw)) {
          throw new SsoError(SSO_ERROR_CODES.CALLBACK_INVALID, {
            status: 400,
            message: 'The callback does not contain a valid login code',
          });
        }
        if (!(await attemptStore.claimCode(raw))) {
          throw new SsoError(SSO_ERROR_CODES.CODE_REPLAY, {
            status: 403,
            message: 'This login code was already used',
          });
        }

        // 4. Server-side exchange. The document is untrusted input.
        const document = await tokenClient.exchange({
          tokenUrl: settings.tokenUrl,
          clientId: settings.clientId,
          code: raw,
        });

        // 5. Reduce to a candidate subject. citizenID is a schema check, not authorization.
        const assertion = normalizeIdentityAssertion(document, {
          ac: raw,
          // The gate for a confirmable claim is the item that governs it (C-08), not the
          // contract-wide status: the latter already gates production readiness separately.
          contractStatus: contractItemStatus('C-08') ?? settings.contractStatus,
          lawfulBasisApproved: settings.lawfulBasisApproved,
          ...(settings.subjectClaim ? { subjectClaim: settings.subjectClaim } : {}),
        });

        // 6. Approved local link is the only thing that can authorize a session.
        const local = await resolveLocalIdentity(assertion);

        // 7. Fresh session, rotated.
        const session = await establishSession({
          previousSessionId,
          localUserId: local.localUserId,
          correlationId,
          issue: sessionManager?.issue,
        });

        return {
          status: 303,
          redirectTo: assertRelativeRedirect(settings.postLoginRedirect),
          correlationId,
          session,
          assertion: {
            provider: assertion.provider,
            subjectClaim: assertion.subjectClaim,
            subjectCertifiedByProvider: assertion.subjectCertifiedByProvider,
            // A boolean only. The subject itself is deliberately not returned: for a confidential
            // claim it is a national id, and for any claim the caller already has it via the resolver.
            subjectIsConfidential: assertion.subjectIsConfidential === true,
          },
          cookies: [clearAttemptCookie],
        };
      });
    },

    /**
     * Local logout, then provider sign-out.
     * POST + CSRF only; the session is destroyed before the redirect is built.
     */
    async logout({ method = 'POST', csrfToken, expectedCsrfToken, session, correlationId } = {}) {
      return run('sso_logout', correlationId, async () => {
        assertLogoutMethod(method);
        assertReady();

        if (!verifyCsrf(expectedCsrfToken, csrfToken)) {
          throw new SsoError(SSO_ERROR_CODES.CSRF_INVALID, { status: 403, message: 'CSRF validation failed' });
        }
        if (!session?.sessionId) {
          throw new SsoError(SSO_ERROR_CODES.SESSION_REQUIRED, { status: 401, message: 'Not signed in' });
        }
        if (typeof sessionManager?.revoke === 'function') {
          await sessionManager.revoke({ sessionId: session.sessionId, correlationId });
        }
        const redirectTo = buildSignoutUrl({
          signoutUrl: settings.signoutUrl,
          clientId: settings.clientId,
          allowedHosts: settings.allowedHosts,
          requireHttps: settings.requireHttps,
        });
        return {
          status: 303,
          redirectTo,
          correlationId,
          cookies: [{ name: SESSION_COOKIE, value: '', ...SESSION_COOKIE_POLICY, maxAge: 0 }],
        };
      });
    },
  };
}

/** A post-login destination must be site-relative; anything else is an open redirect. */
export function assertRelativeRedirect(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'The post-login redirect must be a relative application path',
    });
  }
  return target;
}
