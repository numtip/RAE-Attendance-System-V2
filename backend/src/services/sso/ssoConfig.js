const { HttpError } = require('../../utils/httpError');

function requiredConfig(config) {
  const { authorizationUrl, tokenUrl, userInfoUrl, clientId, clientSecret, callbackUrl } = config.sso;
  return authorizationUrl && tokenUrl && userInfoUrl && clientId && clientSecret && callbackUrl;
}

function assertSsoGate(config) {
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

module.exports = { assertSsoGate, isSsoOperational, requiredConfig };
