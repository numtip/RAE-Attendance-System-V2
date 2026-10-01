const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { assertSsoGate, portalConfigReady } = require('./sso/ssoConfig');
const { createOAuthProvider } = require('./sso/oauthProvider');
const { createSsoStateStore } = require('./sso/ssoStateStore');
const { buildCidUrl } = require('./sso/mjuPortal');
const { summarizeCallbackFields } = require('./sso/callbackDiagnostic');

function assertJwtSecret(config) {
  if (!config.jwt.secret) {
    throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
  }
}

function signAccessToken(config, employee, authMethod = 'sso') {
  return jwt.sign(
    { role: employee.role, email: employee.email, authMethod },
    config.jwt.secret,
    { subject: employee.employeeUid, expiresIn: config.jwt.expiresIn },
  );
}

function createSsoService(deps) {
  const {
    config,
    repositories,
    oauthProvider = createOAuthProvider(config, deps),
    stateStore = createSsoStateStore(),
  } = deps;

  function disabledResponse() {
    assertSsoGate(config);
  }

  return {
    async beginLogin() {
      if (!config.sso.enabled) {
        throw new HttpError(403, 'SSO_DISABLED', 'SSO stays disabled until the MJU callback URL is confirmed');
      }
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
      const email = profile.email || profile.mail || profile.preferred_username;
      if (!email) {
        throw new HttpError(403, 'SSO_USER_UNKNOWN', 'MJU profile did not include an email');
      }

      const employee = await repositories.employees.findByEmail(String(email).toLowerCase());
      if (!employee) {
        throw new HttpError(403, 'SSO_USER_UNKNOWN', 'No employee matches the MJU identity');
      }
      if (employee.status && employee.status !== 'active') {
        throw new HttpError(403, 'SSO_USER_DISABLED', 'Employee is not active');
      }
      if (employee.lockedUntil && new Date(employee.lockedUntil).getTime() > Date.now()) {
        throw new HttpError(403, 'ACCOUNT_LOCKED', 'This account is locked');
      }

      assertJwtSecret(config);
      const refreshToken = randomUUID();
      const expiresAt = new Date(Date.now() + config.jwt.refreshTokenDays * 86400000).toISOString();
      await repositories.refreshTokens.save({
        token: refreshToken,
        employeeUid: employee.employeeUid,
        role: employee.role,
        email: employee.email,
        expiresAt,
        revokedAt: null,
      });

      return {
        accessToken: signAccessToken(config, employee),
        refreshToken,
        employee: {
          employeeUid: employee.employeeUid,
          email: employee.email,
          role: employee.role,
        },
      };
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

module.exports = { createSsoService, signAccessToken };
