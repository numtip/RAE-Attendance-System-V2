const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const config = require('../src/config');
const { createApp } = require('../src/app');
const { createSsoService } = require('../src/services/ssoService');
const {
  createMockOAuthProvider,
  createHttpOAuthProvider,
} = require('../src/services/sso/oauthProvider');
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

const baseJwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: '15m',
  refreshTokenDays: 14,
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

function createEnabledSsoService(overrides = {}) {
  const repos = createFixtureRepositories();
  return createSsoService({
    config: {
      jwt: baseJwtConfig,
      sso: { ...baseSsoConfig, ...overrides.ssoConfig },
    },
    repositories: repos,
    oauthProvider: overrides.oauthProvider ?? createMockOAuthProvider(),
    stateStore: overrides.stateStore ?? createSsoStateStore(),
  });
}

test('contract: SSO_DISABLED when enabled flag is false', async () => {
  const ssoService = createEnabledSsoService({ ssoConfig: { enabled: false } });
  await assert.rejects(() => ssoService.beginLogin(), (err) => err.code === 'SSO_DISABLED');
});

test('contract: SSO_NOT_READY when callback is not confirmed', async () => {
  const ssoService = createEnabledSsoService({ ssoConfig: { callbackConfirmed: false } });
  await assert.rejects(() => ssoService.beginLogin(), (err) => err.code === 'SSO_NOT_READY');
});

test('contract: SSO_NOT_READY when required env fields are missing', async () => {
  const ssoService = createEnabledSsoService({
    ssoConfig: { tokenUrl: '', clientSecret: '' },
  });
  await assert.rejects(() => ssoService.beginLogin(), (err) => err.code === 'SSO_NOT_READY');
});

test('contract: mock provider success flow (login, callback, me, logout)', async () => {
  const stateStore = createSsoStateStore();
  const ssoService = createEnabledSsoService({ stateStore });

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

test('contract: SSO_STATE_INVALID for missing, wrong, or reused state', async () => {
  const stateStore = createSsoStateStore();
  const ssoService = createEnabledSsoService({ stateStore });

  await assert.rejects(
    () => ssoService.handleCallback({ code: 'mock-auth-code', state: 'not-issued' }),
    (err) => err.code === 'SSO_STATE_INVALID',
  );

  const loginUrl = await ssoService.beginLogin();
  const state = new URL(loginUrl).searchParams.get('state');
  await ssoService.handleCallback({ code: 'mock-auth-code', state });

  await assert.rejects(
    () => ssoService.handleCallback({ code: 'mock-auth-code', state }),
    (err) => err.code === 'SSO_STATE_INVALID',
  );
});

function fetchThatAbortsOnSignal() {
  return (_url, options) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true });
    });
}

test('contract: SSO_PROVIDER_TIMEOUT when token endpoint does not respond', async () => {
  const stateStore = createSsoStateStore();
  const httpProvider = createHttpOAuthProvider({
    fetchImpl: fetchThatAbortsOnSignal(),
    timeoutMs: 30,
  });
  const ssoService = createEnabledSsoService({
    ssoConfig: { provider: 'http' },
    oauthProvider: httpProvider,
    stateStore,
  });

  const loginUrl = await ssoService.beginLogin();
  const state = new URL(loginUrl).searchParams.get('state');

  await assert.rejects(
    () => ssoService.handleCallback({ code: 'any-code', state }),
    (err) => err.code === 'SSO_PROVIDER_TIMEOUT',
  );
});

test('contract: SSO_PROVIDER_ERROR when token endpoint returns HTTP error', async () => {
  const stateStore = createSsoStateStore();
  const failingFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: 'unavailable' }),
  });
  const httpProvider = createHttpOAuthProvider({ fetchImpl: failingFetch });
  const ssoService = createEnabledSsoService({
    ssoConfig: { provider: 'http' },
    oauthProvider: httpProvider,
    stateStore,
  });

  const loginUrl = await ssoService.beginLogin();
  const state = new URL(loginUrl).searchParams.get('state');

  await assert.rejects(
    () => ssoService.handleCallback({ code: 'any-code', state }),
    (err) => err.code === 'SSO_PROVIDER_ERROR',
  );
});

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

function scriptedFetch(responses) {
  let index = 0;
  return async () => {
    const step = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: step.ok !== false,
      status: step.status ?? 200,
      text: async () => JSON.stringify(step.body ?? {}),
    };
  };
}

async function callbackWithFetch(responses, repositories) {
  const stateStore = createSsoStateStore();
  const httpProvider = createHttpOAuthProvider({ fetchImpl: scriptedFetch(responses) });
  const ssoService = createSsoService({
    config: {
      jwt: baseJwtConfig,
      sso: { ...baseSsoConfig, provider: 'http' },
    },
    repositories: repositories ?? createFixtureRepositories(),
    oauthProvider: httpProvider,
    stateStore,
  });
  const loginUrl = await ssoService.beginLogin();
  const state = new URL(loginUrl).searchParams.get('state');
  return ssoService.handleCallback({ code: 'any-code', state });
}

test('contract: valid callback issues tokens for a known active employee', async () => {
  const session = await callbackWithFetch([
    { body: { access_token: 'provider-token', token_type: 'Bearer' } },
    { body: { email: 'user@example.test' } },
  ]);
  assert.equal(session.employee.email, 'user@example.test');
  assert.ok(session.accessToken);
});

test('contract: missing claims reject the callback', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { sub: 'only-a-subject' } },
    ]),
    (err) => err.code === 'SSO_USER_UNKNOWN',
  );
});

test('contract: unknown employee rejects the callback', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { email: 'nobody@example.test' } },
    ]),
    (err) => err.code === 'SSO_USER_UNKNOWN',
  );
});

test('contract: disabled employee rejects the callback', async () => {
  const repositories = createFixtureRepositories();
  const previous = repositories.employees.findByEmail.bind(repositories.employees);
  repositories.employees.findByEmail = async (email) => {
    if (email === 'inactive@example.test') {
      return {
        employeeUid: '44444444-4444-4444-4444-444444444444',
        email,
        role: 'user',
        status: 'inactive',
        lockedUntil: null,
      };
    }
    return previous(email);
  };
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { email: 'inactive@example.test' } },
    ], repositories),
    (err) => err.code === 'SSO_USER_DISABLED',
  );
});

test('contract: userinfo error rejects the callback', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { ok: false, status: 500, body: { error: 'userinfo-down' } },
    ]),
    (err) => err.code === 'SSO_PROVIDER_ERROR',
  );
});

test('contract: token response without an access token is rejected', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { token_type: 'Bearer' } },
    ]),
    (err) => err.code === 'SSO_TOKEN_ERROR',
  );
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
