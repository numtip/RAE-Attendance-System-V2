const { HttpError } = require('../utils/httpError');
const { signAccessToken } = require('./sso/ssoTokens');
const {
  assertSsoGate,
  assertProductionSafeSso,
  assertProtocolConfirmed,
  portalConfigReady,
} = require('./sso/ssoConfig');
const { createOAuthProvider } = require('./sso/oauthProvider');
const { createSsoStateStore } = require('./sso/ssoStateStore');
const { createSsoLoginCodeStore } = require('./sso/ssoLoginCodeStore');
const { summarizeUserInfoProfile } = require('./sso/userinfoDiagnostic');
const { buildCidUrl } = require('./sso/mjuPortal');
const { summarizeCallbackFields } = require('./sso/callbackDiagnostic');
const { createSsoIdentityResolutionService } = require('./ssoIdentityResolutionService');
const { createMjuTokenClient, normalizeMjuIdentityResponse } = require('./sso/mjuTokenClient');
const { createMjuPortalGuard } = require('./sso/mjuPortalGuard');

const AC_PATTERN = /^[\x21-\x7E]{1,256}$/; // printable, no whitespace; MJU has not documented the format

function createSsoService(deps) {
  const {
    config,
    repositories,
    mjuTokenClient = createMjuTokenClient({ fetchImpl: deps.fetchImpl, timeoutMs: config.sso?.httpTimeoutMs }),
    portalGuard = createMjuPortalGuard(),
    oauthProvider = createOAuthProvider(config, deps),
    stateStore = createSsoStateStore(),
    loginCodeStore = createSsoLoginCodeStore({
      ttlMs: config.sso.loginHandoffTtlMs,
    }),
    identityResolutionService = createSsoIdentityResolutionService(deps),
  } = deps;

  function disabledResponse() {
    assertSsoGate(config);
  }

  /**
   * Portal token flow opt-in. SSO_MJU_TOKEN_FLOW (default off) is the operator switch.
   * SSO_PROTOCOL_CONTRACT_CONFIRMED is the OAuth written-confirmation gate and is not consulted here:
   * this path uses vendor-sample evidence only and must not be described as MJU IT certified.
   */
  function assertMjuTokenFlowReady() {
    if (!config.sso.tokenUrl || !config.sso.clientId) {
      throw new HttpError(503, 'SSO_NOT_READY', 'SSO environment configuration is incomplete');
    }
  }

  /**
   * Portal callback: validate -> redeem `ac` at token.aspx -> validate the identity document -> only then resolve and
   * open a session. `ac` is a one-shot credential, never an identity.
   */
  async function handleMjuPortalCallback({ ac, error, errorDescription, browserBinding }) {
    assertMjuTokenFlowReady();
    // Burn the browser binding first, whatever happens next: it is single use.
    const bound = portalGuard.consumeBinding(browserBinding);
    if (error) {
      throw new HttpError(401, 'SSO_DENIED', String(errorDescription || error).slice(0, 200));
    }
    if (!bound) {
      throw new HttpError(
        403,
        'SSO_STATE_INVALID',
        'Login was not started in this browser, has expired, or was already used',
      );
    }
    if (typeof ac !== 'string' || !AC_PATTERN.test(ac)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'ac is required');
    }
    if (!portalGuard.claimCode(ac)) {
      throw new HttpError(403, 'SSO_CODE_REPLAY', 'This login code was already used');
    }

    const document = await mjuTokenClient.redeem({
      tokenUrl: config.sso.tokenUrl,
      clientId: config.sso.clientId,
      code: ac,
    });
    const profile = normalizeMjuIdentityResponse(document, {
      subjectClaim: config.sso.subjectClaim,
      ac,
    });

    const session = await identityResolutionService.issueSessionFromOAuthProfile({
      profile,
      rawQuery: { ac },
      source: 'mju_token',
    });
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      employee: session.employee,
    };
  }

  return {
    /**
     * @param {{ browserBinding?: string }} [options] random per-browser value the controller keeps in an
     *   HttpOnly cookie; the OAuth state is bound to it (login-CSRF protection). Required for the OAuth path.
     */
    async beginLogin({ browserBinding } = {}) {
      if (!config.sso.enabled) {
        throw new HttpError(403, 'SSO_DISABLED', 'SSO stays disabled until the MJU callback URL is confirmed');
      }
      assertProductionSafeSso(config);
      if (config.sso.callbackDiagnostic) {
        if (!config.sso.signinUrl || !config.sso.clientId) {
          throw new HttpError(503, 'SSO_NOT_READY', 'SSO environment configuration is incomplete');
        }
        return buildCidUrl(config.sso.signinUrl, config.sso.clientId);
      }
      disabledResponse();
      if (config.sso.signinUrl) {
        if (config.sso.mjuTokenFlow) {
          assertMjuTokenFlowReady();
          if (typeof browserBinding !== 'string' || browserBinding.length < 16) {
            throw new HttpError(500, 'SSO_STATE_BINDING_REQUIRED', 'Login state must be bound to the browser');
          }
          portalGuard.registerBinding(browserBinding);
        }
        return buildCidUrl(config.sso.signinUrl, config.sso.clientId);
      }
      assertProtocolConfirmed(config);
      if (typeof browserBinding !== 'string' || browserBinding.length < 16) {
        throw new HttpError(500, 'SSO_STATE_BINDING_REQUIRED', 'Login state must be bound to the browser');
      }
      const state = stateStore.create({ binding: browserBinding });
      return oauthProvider.buildAuthorizationUrl({
        authorizationUrl: config.sso.authorizationUrl,
        clientId: config.sso.clientId,
        callbackUrl: config.sso.callbackUrl,
        scopes: config.sso.scopes,
        state,
      });
    },

    async handleCallback({
      ac,
      code,
      state,
      error,
      error_description: errorDescription,
      rawQuery,
      method,
      rawBody,
      cookieNames,
      browserBinding,
    }) {
      if (!config.sso.enabled) {
        throw new HttpError(403, 'SSO_DISABLED', 'SSO stays disabled until the MJU callback URL is confirmed');
      }
      assertProductionSafeSso(config);
      if (config.sso.callbackDiagnostic) {
        const body = rawBody && typeof rawBody === 'object' && !Buffer.isBuffer(rawBody) ? rawBody : {};
        const details = {
          method: String(method || 'GET').toUpperCase(),
          query: summarizeCallbackFields(rawQuery),
          body: summarizeCallbackFields(body),
          cookieNames: Array.isArray(cookieNames) ? cookieNames.map(String) : [],
        };
        console.log(`sso_callback_diagnostic ${JSON.stringify(details)}`);
        throw new HttpError(
          503,
          'SSO_NOT_READY',
          'MJU callback query contract is not confirmed',
          details,
        );
      }
      disabledResponse();
      if (config.sso.mjuTokenFlow && portalConfigReady(config.sso)) {
        return handleMjuPortalCallback({
          ac,
          error,
          errorDescription,
          browserBinding,
        });
      }
      if (portalConfigReady(config.sso) && config.sso.provider !== 'mock') {
        throw new HttpError(503, 'SSO_NOT_READY', 'MJU callback query contract is not confirmed');
      }
      assertProtocolConfirmed(config);
      if (error) {
        throw new HttpError(401, 'SSO_DENIED', String(errorDescription || error).slice(0, 200));
      }
      if (typeof code !== 'string' || code.length === 0 || code.length > 2048) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'code is required');
      }
      if (typeof state !== 'string' || state.length === 0 || state.length > 256) {
        throw new HttpError(403, 'SSO_STATE_INVALID', 'OAuth state is missing or expired');
      }
      if (!stateStore.consume(state, browserBinding)) {
        throw new HttpError(
          403,
          'SSO_STATE_INVALID',
          'OAuth state is missing, expired, already used, or not bound to this browser',
        );
      }

      const tokenResponse = await oauthProvider.exchangeCode({
        tokenUrl: config.sso.tokenUrl,
        clientId: config.sso.clientId,
        clientSecret: config.sso.clientSecret,
        callbackUrl: config.sso.callbackUrl,
        code,
      });
      // Only the access token returned by THIS exchange is used. Any id_token is deliberately ignored:
      // MJU has not confirmed OIDC, so nothing in it is validated and nothing in it may identify a user.
      const accessToken = tokenResponse && tokenResponse.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new HttpError(502, 'SSO_TOKEN_ERROR', 'Provider did not return an access token');
      }
      if (tokenResponse.token_type !== undefined && !/^bearer$/i.test(String(tokenResponse.token_type))) {
        throw new HttpError(502, 'SSO_TOKEN_ERROR', 'Provider returned an unsupported token type');
      }

      const profile = await oauthProvider.fetchUserInfo({
        userInfoUrl: config.sso.userInfoUrl,
        accessToken,
      });
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'Provider returned an invalid userinfo document');
      }

      if (config.sso.userinfoProbe) {
        const userinfo = summarizeUserInfoProfile(profile);
        const details = {
          userinfo,
          subjectClaimPresent: Boolean(profile.sub || profile.subject || profile.providerSubject),
          configuredNationalIdClaims: String(config.sso.nationalIdClaims || '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        };
        console.log(`sso_userinfo_probe ${JSON.stringify(details)}`);
        throw new HttpError(
          503,
          'SSO_NOT_READY',
          'MJU userinfo contract probe complete; session not issued',
          details,
        );
      }

      const session = await identityResolutionService.issueSessionFromOAuthProfile({
        profile,
        rawQuery,
      });

      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        employee: session.employee,
      };
    },

    issueLoginHandoff(session) {
      if (!session?.accessToken || !session?.refreshToken || !session?.employee) {
        throw new HttpError(500, 'INTERNAL_ERROR', 'SSO session is incomplete');
      }
      return loginCodeStore.issue({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        employee: session.employee,
      });
    },

    exchangeLoginHandoff({ code }) {
      disabledResponse();
      if (!code || String(code).trim() === '') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'code is required');
      }
      const result = loginCodeStore.consume(String(code).trim());
      if (result.status === 'expired') {
        throw new HttpError(401, 'SSO_HANDOFF_EXPIRED', 'Login code expired');
      }
      if (result.status !== 'ok') {
        throw new HttpError(401, 'SSO_HANDOFF_INVALID', 'Login code is invalid or already used');
      }
      return result.payload;
    },

    async me(auth) {
      disabledResponse();
      const employee = await repositories.employees.findByUid(auth.employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return { ...employee, authMethod: auth.authMethod || 'unknown' };
    },

    async logout({ refreshToken, auth }) {
      disabledResponse();
      if (!refreshToken) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'refreshToken is required');
      }
      const current = await repositories.refreshTokens.find(refreshToken);
      if (!current || current.employeeUid !== auth.employeeUid) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
      }
      await repositories.refreshTokens.revoke(refreshToken);
      const result = { revoked: true };
      if (config.sso.signoutUrl && config.sso.clientId) {
        result.signoutUrl = buildCidUrl(config.sso.signoutUrl, config.sso.clientId);
      }
      return result;
    },

  };
}

module.exports = { createSsoService };
module.exports.signAccessToken = signAccessToken;
