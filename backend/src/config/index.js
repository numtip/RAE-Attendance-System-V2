/**
 * Environment contract for V2. Values stay empty unless the operator sets them.
 * This module does not read the legacy production .env.
 */

const port = Number(process.env.PORT || 3210);

module.exports = {
  app: {
    name: 'RAE Attendance System V2',
    env: process.env.NODE_ENV || 'development',
    port: Number.isInteger(port) && port > 0 ? port : 3210,
    url: process.env.APP_URL || 'http://127.0.0.1:3100',
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
    tokenUrl: process.env.SSO_TOKEN_URL || '',
    userInfoUrl: process.env.SSO_USER_INFO_URL || '',
    clientId: process.env.SSO_CLIENT_ID || '',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    callbackUrl: process.env.SSO_CALLBACK_URL || '',
    signinUrl: process.env.SSO_SIGNIN_URL || '',
    signoutUrl: process.env.SSO_SIGNOUT_URL || '',
    afterSignoutUrl: process.env.SSO_AFTER_SIGNOUT_URL || '',
    callbackDiagnostic: process.env.SSO_CALLBACK_DIAGNOSTIC === 'true',
    httpTimeoutMs: Number(process.env.SSO_HTTP_TIMEOUT_MS || 15_000),
  },
  corsOrigin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173',
};
