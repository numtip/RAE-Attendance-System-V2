const { HttpError } = require('../utils/httpError');
const { signAccessToken } = require('./sso/ssoTokens');
const { assertSsoGate, assertProductionSafeSso, portalConfigReady } = require('./sso/ssoConfig');
const { createOAuthProvider } = require('./sso/oauthProvider');
const { createSsoStateStore } = require('./sso/ssoStateStore');
const { createSsoLoginCodeStore } = require('./sso/ssoLoginCodeStore');
const { summarizeUserInfoProfile } = require('./sso/userinfoDiagnostic');
const { buildCidUrl } = require('./sso/mjuPortal');
const { summarizeCallbackFields } = require('./sso/callbackDiagnostic');
const { createSsoIdentityResolutionService } = require('./ssoIdentityResolutionService');

function createSsoService(deps) {
  const {
    config,
    repositories,
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

  return {
    async beginLogin() {
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
        return buildCidUrl(config.sso.signinUrl, config.sso.clientId);
      }
      const state = stateStore.create();
      return oauthProvider.buildAuthorizationUrl({
        authorizationUrl: config.sso.authorizationUrl,
        clientId: config.sso.clientId,
        callbackUrl: config.sso.callbackUrl,
        scopes: config.sso.scopes,
        state,
      });
    },

    async handleCallback({
      code,
      state,
      error,
      error_description: errorDescription,
      rawQuery,
      method,
      rawBody,
      cookieNames,
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
      if (portalConfigReady(config.sso) && config.sso.provider !== 'mock') {
        throw new HttpError(503, 'SSO_NOT_READY', 'MJU callback query contract is not confirmed');
      }
      if (error) {
        throw new HttpError(401, 'SSO_DENIED', errorDescription || error);
      }
      if (!code) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'code is required');
      }
      if (!stateStore.consume(state)) {
        throw new HttpError(403, 'SSO_STATE_INVALID', 'OAuth state is missing or expired');
      }

      const tokenResponse = await oauthProvider.exchangeCode({
        tokenUrl: config.sso.tokenUrl,
        clientId: config.sso.clientId,
        clientSecret: config.sso.clientSecret,
        callbackUrl: config.sso.callbackUrl,
        code,
      });
      const accessToken = tokenResponse.access_token;
      if (!accessToken) {
        throw new HttpError(502, 'SSO_TOKEN_ERROR', 'Provider did not return an access token');
      }

      const profile = await oauthProvider.fetchUserInfo({
        userInfoUrl: config.sso.userInfoUrl,
        accessToken,
      });

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
