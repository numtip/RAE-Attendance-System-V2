const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const config = require('../src/config');
const { createApp } = require('../src/app');
const { createSsoService } = require('../src/services/ssoService');
const { createMockOAuthProvider } = require('../src/services/sso/oauthProvider');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');

const baseSsoConfig = {
  enabled: true,
  callbackConfirmed: true,
  provider: 'mock',
  scopes: 'openid email',
  authorizationUrl: 'https://sso.example.test/oauth/authorize',
  tokenUrl: 'https://sso.example.test/oauth/token',
  userInfoUrl: 'https://sso.example.test/oauth/userinfo',
  clientId: 'v2-client-id',
  clientSecret: 'v2-client-secret',
  callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
};

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function rawGet(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: response.headers.get('content-type')?.includes('json') ? await response.json() : null,
  };
}

test('SSO gates: disabled, unconfirmed callback, and incomplete config', async () => {
  const repos = createFixtureRepositories();
  const disabled = createSsoService({
    config: { jwt: { secret: 'x', expiresIn: '15m', refreshTokenDays: 14 }, sso: { ...baseSsoConfig, enabled: false } },
    repositories: repos,
    oauthProvider: createMockOAuthProvider(),
  });
  await assert.rejects(() => disabled.beginLogin(), (err) => err.code === 'SSO_DISABLED');

  const unconfirmed = createSsoService({
    config: {
      jwt: { secret: 'x', expiresIn: '15m', refreshTokenDays: 14 },
      sso: { ...baseSsoConfig, callbackConfirmed: false },
    },
    repositories: repos,
    oauthProvider: createMockOAuthProvider(),
  });
  await assert.rejects(() => unconfirmed.beginLogin(), (err) => err.code === 'SSO_NOT_READY');
});

test('mock SSO flow: login redirect, callback tokens, me, logout', async () => {
  const stateStore = createSsoStateStore();
  const repos = createFixtureRepositories();
  const ssoService = createSsoService({
    config: {
      jwt: { secret: process.env.JWT_SECRET, expiresIn: '15m', refreshTokenDays: 14 },
      sso: baseSsoConfig,
    },
    repositories: repos,
    oauthProvider: createMockOAuthProvider(),
    stateStore,
  });

  const loginUrl = await ssoService.beginLogin();
  const parsed = new URL(loginUrl);
  assert.match(parsed.hostname, /sso\.example\.test/);
  const state = parsed.searchParams.get('state');
  assert.ok(state);

  const session = await ssoService.handleCallback({ code: 'mock-auth-code', state });
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.equal(session.employee.email, 'user@example.test');

  const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.authMethod, 'sso');

  const profile = await ssoService.me({
    employeeUid: session.employee.employeeUid,
    role: session.employee.role,
    email: session.employee.email,
    authMethod: 'sso',
  });
  assert.equal(profile.email, 'user@example.test');

  const loggedOut = await ssoService.logout({
    refreshToken: session.refreshToken,
    auth: { employeeUid: session.employee.employeeUid },
  });
  assert.equal(loggedOut.revoked, true);
});

test('SSO HTTP routes stay closed by default', async () => {
  const previous = { ...config.sso };
  config.sso.enabled = false;
  config.sso.callbackConfirmed = false;
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await rawGet(port, '/api/v1/auth/sso/login');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'SSO_DISABLED');
  } finally {
    config.sso.enabled = previous.enabled;
    config.sso.callbackConfirmed = previous.callbackConfirmed;
    server.close();
  }
});

test('SSO login redirect when enabled with mock provider env', async () => {
  const previous = {
    enabled: config.sso.enabled,
    callbackConfirmed: config.sso.callbackConfirmed,
    provider: config.sso.provider,
    authorizationUrl: config.sso.authorizationUrl,
    tokenUrl: config.sso.tokenUrl,
    userInfoUrl: config.sso.userInfoUrl,
    clientId: config.sso.clientId,
    clientSecret: config.sso.clientSecret,
    callbackUrl: config.sso.callbackUrl,
  };
  Object.assign(config.sso, baseSsoConfig);
  process.env.SSO_PROVIDER = 'mock';

  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const login = await rawGet(port, '/api/v1/auth/sso/login');
    assert.equal(login.status, 302);
    assert.ok(login.location.includes('state='));

    const state = new URL(login.location).searchParams.get('state');
    const callback = await rawGet(
      port,
      `/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    assert.ok(callback.location.includes('sso=success'));
  } finally {
    Object.assign(config.sso, previous);
    delete process.env.SSO_PROVIDER;
    server.close();
  }
});
