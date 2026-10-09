const { HttpError } = require('../../utils/httpError');

function portalConfigReady(sso) {
  return Boolean(sso.signinUrl && sso.signoutUrl && sso.clientId && sso.callbackUrl);
}

function oauthConfigReady(sso) {
  const { authorizationUrl, tokenUrl, userInfoUrl, clientId, clientSecret, callbackUrl } = sso;
  return Boolean(authorizationUrl && tokenUrl && userInfoUrl && clientId && clientSecret && callbackUrl);
}

function requiredConfig(config) {
  return portalConfigReady(config.sso) || oauthConfigReady(config.sso);
}

const SSO_ENDPOINT_FIELDS = ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'callbackUrl', 'signinUrl', 'signoutUrl'];

/**
 * Production hardening (metadata only, no secrets are read or echoed):
 *  - the mock provider (fixed fake identity) must never run in production;
 *  - every configured SSO endpoint must be https in production (tokens and the citizen ID travel over them).
 */
function assertProductionSafeSso(config) {
  if (config.env !== 'production') return;
  if (config.sso.provider === 'mock') {
    throw new HttpError(503, 'CONFIG_ERROR', 'SSO_PROVIDER=mock is not allowed in production');
  }
  const insecure = SSO_ENDPOINT_FIELDS.filter((field) => config.sso[field] && !/^https:\/\//i.test(config.sso[field]));
  if (insecure.length > 0) {
    throw new HttpError(503, 'CONFIG_ERROR', `SSO endpoints must use https in production: ${insecure.join(', ')}`);
  }
}
function assertSsoGate(config) {
  assertProductionSafeSso(config);
  if (!config.sso.enabled) {
    throw new HttpError(403, 'SSO_DISABLED', 'SSO stays disabled until the MJU callback URL is confirmed');
  }
  if (!config.sso.callbackConfirmed) {
    throw new HttpError(503, 'SSO_NOT_READY', 'SSO callback registration is not confirmed');
  }
  if (!requiredConfig(config)) {
    throw new HttpError(503, 'SSO_NOT_READY', 'SSO environment configuration is incomplete');
  }
}

function isSsoOperational(config) {
  return config.sso.enabled && config.sso.callbackConfirmed && requiredConfig(config);
}

module.exports = {
  assertSsoGate,
  assertProductionSafeSso,
  isSsoOperational,
  requiredConfig,
  portalConfigReady,
};
