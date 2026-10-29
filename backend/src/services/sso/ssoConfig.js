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

// A live (non-mock) login must not start while the subject contract is unconfirmed: the callback
// has no approved-link gate and maps the provider profile e-mail to an employee, which policy S7
// forbids and S3/S6 do not permit. The mock provider is a test double and stays usable. This is
// deliberately separate from assertSsoGate: the identity-chain service uses that gate and has its
// own subject-contract handling (mjuSubjectAdapter -> SSO_SUBJECT_UNKNOWN).
function assertLiveIdentityGate(config) {
  // A test double must never be the identity provider of a deployed environment: it would bypass
  // the approved-link requirement entirely.
  if (config.sso.provider === 'mock' && (process.env.NODE_ENV || 'development') === 'production') {
    throw new HttpError(503, 'SSO_MOCK_PROVIDER_REFUSED', 'The mock SSO provider is refused in production');
  }
  if (config.sso.provider !== 'mock' && config.sso.subjectContractConfirmed !== true) {
    throw new HttpError(
      503,
      'SSO_SUBJECT_CONTRACT_UNCONFIRMED',
      'MJU subject contract is unconfirmed, so no live SSO sign-in is allowed',
    );
  }
}

function isSsoOperational(config) {
  return config.sso.enabled && config.sso.callbackConfirmed && requiredConfig(config);
}

module.exports = {
  assertLiveIdentityGate,
  assertSsoGate,
  isSsoOperational,
  requiredConfig,
  portalConfigReady,
};
