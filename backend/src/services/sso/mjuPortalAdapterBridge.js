const { pathToFileURL } = require('node:url');
const { randomBytes, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

const { HttpError } = require('../../utils/httpError');
const { assertSsoGate } = require('./ssoConfig');
const { assertNotSampleClientId, SsoSignoutError } = require('./ssoSignout');
const { createIdentityResolutionService } = require('../identityResolutionService');
const { PROVIDER_MJU_SSO } = require('../../domain/identityLink');

let standardModulePromise = null;

/**
 * Load the vendored `@mju/sso-integration` standard (`v1.0.0-rc.6`).
 * Uses `pathToFileURL` so ESM `import()` succeeds on both Windows and Linux/Docker.
 */
function loadMjuSsoStandard() {
  if (!standardModulePromise) {
    const entryPath = require.resolve('../../vendor/mju-sso-integration/src/index.js');
    const riskPath = require.resolve('../../vendor/mju-sso-integration/src/riskAcceptance.js');
    standardModulePromise = Promise.all([
      import(pathToFileURL(entryPath).href),
      import(pathToFileURL(riskPath).href),
    ]).then(([indexMod, riskMod]) => ({
      ...indexMod,
      loadOwnerRiskAcceptance: riskMod.loadOwnerRiskAcceptance,
    }));
  }
  return standardModulePromise;
}

function isProductionEnv(config) {
  const raw = config?.app?.env ?? config?.env ?? process.env.NODE_ENV ?? 'development';
  return String(raw).trim().toLowerCase() === 'production';
}

function isPrivateOrLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.test')
  ) {
    return true;
  }
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return true;
  }
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function sanitizeUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || userAgent === '') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = userAgent.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

function assertValidRaeClientId(clientId) {
  try {
    return assertNotSampleClientId(clientId);
  } catch (error) {
    if (error instanceof SsoSignoutError) {
      throw new HttpError(503, error.code, error.message);
    }
    throw error;
  }
}

function assertPortalProductionSafety(config, standard) {
  if (!isProductionEnv(config)) return null;

  const sso = config?.sso ?? {};
  if (sso.requireHttps === false) {
    throw new HttpError(
      503,
      'SSO_CONFIG_INVALID',
      'SSO_REQUIRE_HTTPS cannot be false in production',
    );
  }

  const allowedHosts =
    Array.isArray(sso.allowedHosts) && sso.allowedHosts.length > 0
      ? sso.allowedHosts
      : standard.PROVIDER_ALLOWED_HOSTS;

  for (const host of allowedHosts) {
    if (isPrivateOrLoopbackHost(host)) {
      throw new HttpError(
        503,
        'SSO_UNTRUSTED_ENDPOINT',
        'Private or loopback SSO hosts are refused in production',
      );
    }
  }

  for (const rawUrl of [sso.signinUrl, sso.signoutUrl, sso.tokenUrl]) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ''));
    } catch {
      throw new HttpError(503, 'SSO_CONFIG_INVALID', 'SSO endpoint is not a valid URL');
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new HttpError(
        503,
        'SSO_UNTRUSTED_ENDPOINT',
        'Private or loopback SSO endpoints are refused in production',
      );
    }
  }

  if (sso.allowUnverifiedContract === true) {
    return standard.loadOwnerRiskAcceptance(sso.ownerRiskAcceptance);
  }
  return null;
}

function toHttpError(error, standard) {
  if (error instanceof HttpError) return error;
  if (error instanceof standard.SsoError) {
    const pub = standard.toPublicError(error);
    return new HttpError(pub.status, pub.code, pub.message, pub.details);
  }
  return error;
}

function signSsoSessionAccessToken(config, employee, jti) {
  if (!config?.jwt?.secret) {
    throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
  }
  return jwt.sign(
    { role: employee.role, email: employee.email, authMethod: 'sso' },
    config.jwt.secret,
    {
      subject: employee.employeeUid,
      expiresIn: config.jwt.expiresIn,
      algorithm: 'HS256',
      jwtid: jti,
    },
  );
}

/**
 * `auth_logs.event_type` is ENUM('login','logout','refresh','failed_login','locked') (migration 009).
 * SSO events reuse `login` / `failed_login` and are told apart by this marker in `error_message`:
 * the earlier `sso_login` / `sso_login_failed` values are not in the enum, so under strict SQL mode
 * every insert failed and was swallowed — no SSO login was ever audited.
 */
const SSO_AUDIT_MARK = 'via=mju_sso';

async function appendAuthLog(repositories, entry) {
  if (!repositories?.authLogs?.append) return;
  try {
    await repositories.authLogs.append(entry);
  } catch (error) {
    // Audit logging failures must not turn a valid decision into an unhandled crash, but they must
    // not be silent either. Class and code only: a driver message can echo SQL values.
    console.error(JSON.stringify({ authLogAppendFailed: true, code: error?.code ?? null }));
  }
}

/**
 * Derive the exact 64-hex application-scoped HMAC `subjectKey` that `createMjuSsoAdapter` passes
 * to `identityResolver` when `subjectClaim === 'citizenID'`.
 *
 * Used by operator link-onboarding scripts and tests so the HMAC derivation lives in one place
 * (`@mju/sso-integration/src/identityMapping.js`).
 */
async function deriveRaeSsoSubjectKey({
  citizenId,
  hmacKey,
  appId = 'rae-attendance-v2',
  provider = 'mju-sso',
} = {}) {
  const standard = await loadMjuSsoStandard();
  try {
    return standard.deriveSubjectKey({
      appId,
      provider,
      subject: citizenId,
      hmacKey,
    });
  } catch (error) {
    throw toHttpError(error, standard);
  }
}

/**
 * Bridge connecting `@mju/sso-integration` (`v1.0.0-rc.6`) to RAE Attendance System V2:
 *   - reuses `createMjuSsoAdapter`, `createTokenClient`, `normalizeIdentityAssertion`,
 *     `deriveSubjectKey`, `createRateLimiter`, and `loadOwnerRiskAcceptance` directly;
 *   - backs attempt binding and single-use `ac` replay protection with V2's `stateStore`
 *     (MariaDB `028_sso_login_attempt` in persistent deployments);
 *   - resolves ONLY pre-approved `employee_identity_links` rows via `identityResolutionService`
 *     (never auto-linking, never auto-approving, never matching by email or name);
 *   - issues rotated V2 JWT + refresh-token sessions carrying application-owned RBAC roles.
 */
function createMjuPortalAdapterBridge({
  config,
  repositories,
  stateStore,
  fetchImpl,
  logger,
} = {}) {
  const identityResolution = createIdentityResolutionService({ repositories });
  let limitersPromise = null;

  function getLimiters() {
    if (!limitersPromise) {
      limitersPromise = loadMjuSsoStandard().then((standard) => {
        const max = Number(config?.sso?.rateLimitMax || 20);
        const windowMs = Number(config?.sso?.rateLimitWindowMs || 60_000);
        return {
          login: standard.createRateLimiter({ max, windowMs }),
          callback: standard.createRateLimiter({ max, windowMs }),
        };
      });
    }
    return limitersPromise;
  }

  function callerKey(clientIp) {
    const ip = typeof clientIp === 'string' && clientIp.trim() !== '' ? clientIp.trim() : 'local';
    return `ip:${ip}`;
  }

  function buildAdapterSettings(standard) {
    const sso = config?.sso ?? {};
    const allowedHosts =
      Array.isArray(sso.allowedHosts) && sso.allowedHosts.length > 0
        ? sso.allowedHosts
        : standard.PROVIDER_ALLOWED_HOSTS;

    return {
      enabled: sso.enabled === true,
      allowUnverifiedContract: sso.allowUnverifiedContract === true,
      clientId: assertValidRaeClientId(sso.clientId),
      signinUrl: sso.signinUrl,
      signoutUrl: sso.signoutUrl,
      tokenUrl: sso.tokenUrl,
      allowedHosts,
      requireHttps: isProductionEnv(config) ? true : sso.requireHttps !== false,
      postLoginRedirect:
        typeof sso.postLoginRedirect === 'string' && sso.postLoginRedirect.startsWith('/')
          ? sso.postLoginRedirect
          : '/profile',
      lawfulBasisApproved: sso.lawfulBasisApproved === true,
      hmacKey: typeof sso.hmacKey === 'string' ? sso.hmacKey : '',
      appId:
        typeof sso.appId === 'string' && sso.appId.trim() !== ''
          ? sso.appId.trim()
          : 'rae-attendance-v2',
      ...(sso.subjectClaim ? { subjectClaim: sso.subjectClaim } : {}),
    };
  }

  function buildAttemptStoreBridge(standard, suppliedBinding) {
    const codeTtlMs = Number(config?.sso?.codeReplayTtlMs || standard.DEFAULT_CODE_TTL_MS);
    return {
      kind: `rae-${stateStore?.kind ?? 'state-store'}`,
      newBinding() {
        if (typeof suppliedBinding === 'string' && suppliedBinding.length >= 16) {
          return suppliedBinding;
        }
        return randomBytes(32).toString('base64url');
      },
      async begin(binding) {
        await stateStore.registerAttempt(binding);
      },
      async consume(binding) {
        return stateStore.consumeAttempt(binding);
      },
      async claimCode(code) {
        return stateStore.claimCodeOnce(code, { ttlMs: codeTtlMs });
      },
    };
  }

  function emitAuditLog(record) {
    if (typeof logger === 'function') {
      logger(record);
    }
  }

  return {
    async manifest() {
      const standard = await loadMjuSsoStandard();
      const adapter = standard.createMjuSsoAdapter();
      return adapter.manifest();
    },

    async beginLogin({ browserBinding, clientIp, correlationId } = {}) {
      const standard = await loadMjuSsoStandard();
      try {
        if (!config?.sso?.enabled) {
          throw new HttpError(
            403,
            'SSO_DISABLED',
            'SSO stays disabled until the MJU callback URL is confirmed',
          );
        }
        const limiters = await getLimiters();
        standard.assertWithinLimit(limiters.login.check(callerKey(clientIp)));

        assertSsoGate(config);
        assertPortalProductionSafety(config, standard);

        if (
          config.sso.requireLoginBinding === true &&
          (typeof browserBinding !== 'string' || browserBinding.length < 16)
        ) {
          throw new HttpError(
            500,
            'SSO_STATE_BINDING_REQUIRED',
            'Login state must be bound to the browser',
          );
        }

        const settings = buildAdapterSettings(standard);
        const adapter = standard.createMjuSsoAdapter({
          config: settings,
          deps: {
            attemptStore: buildAttemptStoreBridge(standard, browserBinding),
            logger: emitAuditLog,
          },
        });

        const started = await adapter.beginLogin({
          correlationId: correlationId || randomBytes(8).toString('hex'),
        });
        return started.redirectTo;
      } catch (error) {
        throw toHttpError(error, standard);
      }
    },

    async handleCallback({
      method = 'GET',
      rawQuery,
      ac,
      error: queryError,
      browserBinding,
      previousSessionId = null,
      clientIp,
      userAgent,
      correlationId,
    } = {}) {
      const standard = await loadMjuSsoStandard();
      const corrId = correlationId || randomBytes(8).toString('hex');
      try {
        // Transport method check runs first so POST/PUT/DELETE callbacks receive 405 Allow: GET.
        standard.assertCallbackMethod(method);

        if (!config?.sso?.enabled) {
          throw new HttpError(
            403,
            'SSO_DISABLED',
            'SSO stays disabled until the MJU callback URL is confirmed',
          );
        }

        const limiters = await getLimiters();
        standard.assertWithinLimit(limiters.callback.check(callerKey(clientIp)));

        assertSsoGate(config);
        assertPortalProductionSafety(config, standard);

        if (!config?.jwt?.secret) {
          throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
        }

        const settings = buildAdapterSettings(standard);
        const tokenClient = standard.createTokenClient({
          ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
          timeoutMs: Number(config?.sso?.httpTimeoutMs || standard.DEFAULT_TIMEOUT_MS),
          allowedHosts: settings.allowedHosts,
          requireHttps: settings.requireHttps,
        });

        let resolvedEmployee = null;
        let resolvedLink = null;
        let issuedSession = null;

        const adapter = standard.createMjuSsoAdapter({
          config: settings,
          deps: {
            tokenClient,
            attemptStore: buildAttemptStoreBridge(standard),
            logger: emitAuditLog,
            identityResolver: async ({ subject }) => {
              try {
                const resolved = await identityResolution.resolve(PROVIDER_MJU_SSO, subject);
                resolvedEmployee = resolved.employee;
                resolvedLink = resolved.link;
                return {
                  status: 'approved',
                  localUserId: resolved.employee.employeeUid,
                };
              } catch (err) {
                if (err instanceof HttpError) {
                  if (err.code === 'IDENTITY_UNKNOWN') {
                    return { status: 'unknown' };
                  }
                  if (err.code === 'IDENTITY_NOT_APPROVED') {
                    return { status: 'candidate' };
                  }
                  if (err.code === 'SSO_USER_DISABLED') {
                    return { status: 'disabled' };
                  }
                  if (err.code === 'IDENTITY_CONFLICT' || err.code === 'IDENTITY_SUBJECT_CONFLICT') {
                    return { status: 'conflict' };
                  }
                }
                throw err;
              }
            },
            sessionManager: {
              async issue({ localUserId, previousSessionId: prevId }) {
                if (!resolvedEmployee || resolvedEmployee.employeeUid !== localUserId) {
                  throw new HttpError(
                    403,
                    'SSO_IDENTITY_UNLINKED',
                    'Approved employee context is missing',
                  );
                }
                let jti = randomUUID();
                while (prevId && jti === prevId) {
                  jti = randomUUID();
                }
                const refreshToken = randomUUID();
                const expiresAt = new Date(
                  Date.now() + Number(config.jwt.refreshTokenDays || 14) * 86_400_000,
                ).toISOString();

                await repositories.refreshTokens.save({
                  token: refreshToken,
                  employeeUid: resolvedEmployee.employeeUid,
                  role: resolvedEmployee.role,
                  email: resolvedEmployee.email,
                  expiresAt,
                  revokedAt: null,
                });

                const accessToken = signSsoSessionAccessToken(config, resolvedEmployee, jti);

                await appendAuthLog(repositories, {
                  employeeUid: resolvedEmployee.employeeUid,
                  email: resolvedEmployee.email,
                  eventType: 'login',
                  success: true,
                  ipAddress: clientIp ?? null,
                  userAgent: sanitizeUserAgent(userAgent),
                  errorMessage: SSO_AUDIT_MARK,
                });

                issuedSession = {
                  accessToken,
                  refreshToken,
                  employee: {
                    employeeUid: resolvedEmployee.employeeUid,
                    email: resolvedEmployee.email,
                    role: resolvedEmployee.role,
                  },
                  linkId: resolvedLink?.id ?? null,
                };
                return { sessionId: jti };
              },
            },
          },
        });

        const query =
          rawQuery && typeof rawQuery === 'object'
            ? rawQuery
            : {
                ...(ac !== undefined ? { ac } : {}),
                ...(queryError !== undefined ? { error: queryError } : {}),
              };
        const cookies =
          typeof browserBinding === 'string' && browserBinding !== ''
            ? { [standard.ATTEMPT_COOKIE]: browserBinding }
            : {};

        const done = await adapter.handleCallback({
          method,
          query,
          cookies,
          previousSessionId,
          correlationId: corrId,
        });

        if (!issuedSession) {
          throw new HttpError(500, 'SSO_SESSION_ROTATION', 'SSO callback did not produce a session');
        }

        return {
          accessToken: issuedSession.accessToken,
          refreshToken: issuedSession.refreshToken,
          employee: issuedSession.employee,
          assertion: done.assertion,
        };
      } catch (error) {
        await appendAuthLog(repositories, {
          employeeUid: null,
          email: null,
          eventType: 'failed_login',
          success: false,
          ipAddress: clientIp ?? null,
          userAgent: sanitizeUserAgent(userAgent),
          errorMessage: `${SSO_AUDIT_MARK}:${error?.code ? String(error.code).slice(0, 48) : 'SSO_CALLBACK_FAILED'}`,
        });
        throw toHttpError(error, standard);
      }
    },
  };
}

module.exports = {
  createMjuPortalAdapterBridge,
  deriveRaeSsoSubjectKey,
  isPrivateOrLoopbackHost,
  isProductionEnv,
  loadMjuSsoStandard,
};
