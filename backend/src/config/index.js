/**
 * Environment contract for V2. Values stay empty unless the operator sets them.
 * This module does not read the legacy production .env.
 */

const port = Number(process.env.PORT || 3210);

/** off | shadow | on. Anything else (including unset) is off: the engine never turns on by accident. */
function leaveEngineFlag(value) {
  const flag = String(value || '').trim().toLowerCase();
  return flag === 'shadow' || flag === 'on' ? flag : 'off';
}

module.exports = {
  leaveEngineFlag,
  app: {
    name: 'RAE Attendance System V2',
    env: process.env.NODE_ENV || 'development',
    port: Number.isInteger(port) && port > 0 ? port : 3210,
    url: process.env.APP_URL || 'http://127.0.0.1:3100',
  },
  leave: {
    entitlementEngine: leaveEngineFlag(process.env.LEAVE_ENTITLEMENT_ENGINE),
  },
  database: {
    host: process.env.DB_HOST || '',
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
  },
  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 14),
  },
  sso: {
    enabled: process.env.SSO_ENABLED === 'true',
    callbackConfirmed: process.env.SSO_CALLBACK_CONFIRMED === 'true',
    provider: process.env.SSO_PROVIDER || 'http',
    scopes: process.env.SSO_SCOPES || 'openid profile email',
    authorizationUrl: process.env.SSO_AUTHORIZATION_URL || '',
    tokenUrl: process.env.SSO_TOKEN_URL || process.env.MJU_SSO_TOKEN_URL || '',
    userInfoUrl: process.env.SSO_USER_INFO_URL || '',
    clientId: process.env.SSO_CLIENT_ID || process.env.MJU_CLIENT_ID || '',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    callbackUrl: process.env.SSO_CALLBACK_URL || '',
    signinUrl: process.env.SSO_SIGNIN_URL || process.env.MJU_SSO_SIGNIN_URL || '',
    signoutUrl: process.env.SSO_SIGNOUT_URL || process.env.MJU_SSO_SIGNOUT_URL || '',
    afterSignoutUrl: process.env.SSO_AFTER_SIGNOUT_URL || '',
    callbackDiagnostic: process.env.SSO_CALLBACK_DIAGNOSTIC === 'true',
    subjectContractConfirmed: process.env.SSO_SUBJECT_CONTRACT_CONFIRMED === 'true',
    httpTimeoutMs: Number(process.env.SSO_HTTP_TIMEOUT_MS || process.env.MJU_SSO_TIMEOUT_MS || 15_000),
    // MJU SSO standard adapter (@mju/sso-integration v1.0.0-rc.6) settings for SSO_PROVIDER=portal:
    allowedHosts: (process.env.SSO_ALLOWED_HOSTS || process.env.MJU_SSO_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    requireHttps:
      (process.env.SSO_REQUIRE_HTTPS ?? process.env.MJU_SSO_REQUIRE_HTTPS ?? 'true')
        .trim()
        .toLowerCase() !== 'false',
    allowUnverifiedContract:
      process.env.SSO_ALLOW_UNVERIFIED_CONTRACT === 'true' ||
      process.env.MJU_SSO_ALLOW_UNVERIFIED_CONTRACT === 'true',
    ownerRiskAcceptance:
      process.env.SSO_OWNER_RISK_ACCEPTANCE || process.env.MJU_SSO_OWNER_RISK_ACCEPTANCE || '',
    subjectClaim:
      (process.env.SSO_SUBJECT_CLAIM || process.env.MJU_SSO_SUBJECT_CLAIM || '').trim() || undefined,
    appId: (process.env.SSO_APP_ID || process.env.MJU_SSO_APP_ID || 'rae-attendance-v2').trim(),
    hmacKey: (process.env.SSO_HMAC_KEY || process.env.MJU_SSO_HMAC_KEY || '').trim(),
    lawfulBasisApproved:
      process.env.SSO_LAWFUL_BASIS_APPROVED === 'true' ||
      process.env.MJU_SSO_LAWFUL_BASIS_APPROVED === 'true',
    postLoginRedirect:
      process.env.SSO_POST_LOGIN_REDIRECT || process.env.MJU_SSO_POST_LOGIN_REDIRECT || '/profile',
    handoffCookie: process.env.SSO_HANDOFF_COOKIE || 'rae_sso_handoff',
    handoffTtlMs: Number(process.env.SSO_HANDOFF_TTL_MS || 45_000),
    codeReplayTtlMs: Number(process.env.SSO_CODE_REPLAY_TTL_MS || 60 * 60 * 1000),
    rateLimitMax: Number(process.env.SSO_RATE_LIMIT_MAX || process.env.MJU_SSO_RATE_LIMIT_MAX || 20),
    rateLimitWindowMs: Number(process.env.SSO_RATE_LIMIT_WINDOW_MS || 60_000),
    // G-02: browser binding for a login attempt. The binding cookie is HttpOnly, Secure outside
    // development, SameSite=Lax (it must survive the provider's top-level redirect back).
    loginBindingCookie: process.env.SSO_LOGIN_BINDING_COOKIE || 'rae_sso_bind',
    loginBindingTtlMs: Number(process.env.SSO_LOGIN_BINDING_TTL_MS || 10 * 60 * 1000),
    // A callback without the binding is refused. Forced on in production regardless of the env
    // value, so a wiring regression cannot quietly disable it.
    requireLoginBinding:
      process.env.SSO_REQUIRE_LOGIN_BINDING === 'true' ||
      String(process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production',
    // 'mariadb' (shared, durable) or 'memory' (single process only, refused in production).
    loginAttemptStore: process.env.SSO_LOGIN_ATTEMPT_STORE || '',
  },
  corsOrigin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173',
  attendanceCore: {
    url: process.env.ATTENDANCE_CORE_URL || '',
    timeoutMs: Number(process.env.ATTENDANCE_CORE_TIMEOUT_MS || 8000),
  },
};
