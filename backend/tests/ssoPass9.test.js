require('./helpers/syntheticIdentifierKeys');
const { TEST_BINDING } = require('./helpers/ssoTestBinding');
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createSsoService } = require('../src/services/ssoService');
const { createMockOAuthProvider } = require('../src/services/sso/oauthProvider');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');
const { createSsoLoginCodeStore } = require('../src/services/sso/ssoLoginCodeStore');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createApp } = require('../src/app');
const { summarizeUserInfoProfile } = require('../src/services/sso/userinfoDiagnostic');
const config = require('../src/config');

const baseSsoConfig = {
  enabled: true,
  callbackConfirmed: true,
  protocolContractConfirmed: true,
  subjectContractConfirmed: true,
  provider: 'mock',
  scopes: 'openid email',
  authorizationUrl: 'https://sso.example.test/oauth/authorize',
  tokenUrl: 'https://sso.example.test/oauth/token',
  userInfoUrl: 'https://sso.example.test/oauth/userinfo',
  clientId: 'v2-client-id',
  clientSecret: 'v2-client-secret',
  callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
  loginHandoffTtlMs: 45_000,
};

const baseJwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: '15m',
  refreshTokenDays: 14,
};

const fakeCitizenId = '9900000000001';

function createService(overrides = {}) {
  const repositories = createFixtureRepositories();
  const stateStore = overrides.stateStore ?? createSsoStateStore();
  return {
    repositories,
    stateStore,
    ssoService: createSsoService({
      config: {
        jwt: baseJwtConfig,
        sso: { ...baseSsoConfig, ...overrides.ssoConfig },
      },
      repositories,
      oauthProvider: overrides.oauthProvider ?? createMockOAuthProvider(),
      stateStore,
      loginCodeStore: overrides.loginCodeStore,
    }),
  };
}

async function loginSession(ssoService, _stateStore) {
  const loginUrl = await ssoService.beginLogin({ browserBinding: TEST_BINDING });
  const state = new URL(loginUrl).searchParams.get('state');
  return ssoService.handleCallback({ code: 'mock-auth-code', state, browserBinding: TEST_BINDING });
}

test('valid one-time code exchange returns session tokens', async () => {
  const { ssoService, stateStore } = createService();
  const session = await loginSession(ssoService, stateStore);
  const code = ssoService.issueLoginHandoff(session);
  const exchanged = ssoService.exchangeLoginHandoff({ code });
  assert.equal(exchanged.accessToken, session.accessToken);
  assert.equal(exchanged.refreshToken, session.refreshToken);
  assert.equal(exchanged.employee.employeeUid, session.employee.employeeUid);
});

test('replay code is rejected', async () => {
  const { ssoService, stateStore } = createService();
  const session = await loginSession(ssoService, stateStore);
  const code = ssoService.issueLoginHandoff(session);
  ssoService.exchangeLoginHandoff({ code });
  assert.throws(
    () => ssoService.exchangeLoginHandoff({ code }),
    (err) => err.code === 'SSO_HANDOFF_INVALID',
  );
});

test('expired code is rejected', async () => {
  const { ssoService, stateStore } = createService({
    loginCodeStore: createSsoLoginCodeStore({
      ttlMs: 1,
      now: () => Date.now(),
    }),
  });
  const session = await loginSession(ssoService, stateStore);
  const code = ssoService.issueLoginHandoff(session);
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.throws(
    () => ssoService.exchangeLoginHandoff({ code }),
    (err) => err.code === 'SSO_HANDOFF_EXPIRED',
  );
});

test('unknown code is rejected', async () => {
  const { ssoService } = createService();
  assert.throws(
    () => ssoService.exchangeLoginHandoff({ code: 'deadbeef'.repeat(6) }),
    (err) => err.code === 'SSO_HANDOFF_INVALID',
  );
});

test('userinfo probe returns masked manifest without raw citizen ID', async () => {
  const summary = summarizeUserInfoProfile({
    citizenID: fakeCitizenId,
    email: 'user@example.test',
    firstName: 'SecretName',
    sub: 'opaque-subject-value',
    access_token: 'must-not-appear',
    code: 'oauth-code-must-not-appear',
  });
  const packed = JSON.stringify(summary);
  assert.equal(packed.includes(fakeCitizenId), false);
  assert.equal(packed.includes('must-not-appear'), false);
  assert.equal(packed.includes('user@example.test'), false);
  assert.equal(packed.includes('SecretName'), false);
  assert.equal(packed.includes('oauth-code-must-not-appear'), false);
  assert.ok(summary.nationalIdCandidates.some((row) => row.name === 'citizenID'));
  assert.equal(summary.nationalIdCandidates[0].candidateClassification, 'possible_national_id');
  assert.match(summary.nationalIdCandidates[0].maskedSample, /\*\*\*\*/);
});

test('userinfo probe mode issues no session', async () => {
  const { ssoService } = createService({
    ssoConfig: { userinfoProbe: true },
  });
  const loginUrl = await ssoService.beginLogin({ browserBinding: TEST_BINDING });
  const state = new URL(loginUrl).searchParams.get('state');
  await assert.rejects(
    () => ssoService.handleCallback({ code: 'mock-auth-code', state, browserBinding: TEST_BINDING }),
    (err) => err.code === 'SSO_NOT_READY' && Boolean(err.details?.userinfo),
  );
});

test('redirect handoff URL contains opaque code only', async () => {
  const previousSso = { ...config.sso };
  const previousAppUrl = config.app.url;
  Object.assign(config.sso, baseSsoConfig);
  config.app.url = 'http://127.0.0.1:3100';
  process.env.SSO_PROVIDER = 'mock';

  const app = createApp({ dataSource: 'fixture' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sso/login`, { redirect: 'manual' });
    const state = new URL(loginRes.headers.get('location')).searchParams.get('state');
    const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const callbackRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { cookie } },
    );
    assert.equal(callbackRes.status, 302);
    const location = callbackRes.headers.get('location');
    assert.ok(location.includes('/auth/sso/complete'));
    assert.ok(location.includes('code='));
    assert.equal(location.includes(fakeCitizenId), false);
    assert.equal(location.includes('eyJ'), false);
    const code = new URL(location).searchParams.get('code');
    assert.ok(code && code.length >= 32);
  } finally {
    server.close();
    Object.assign(config.sso, previousSso);
    config.app.url = previousAppUrl;
    delete process.env.SSO_PROVIDER;
  }
});

test('exchange HTTP endpoint returns tokens without national_id in JWT', async () => {
  const previousSso = { ...config.sso };
  const previousAppUrl = config.app.url;
  Object.assign(config.sso, baseSsoConfig);
  config.app.url = 'http://127.0.0.1:3100';
  process.env.SSO_PROVIDER = 'mock';
  const app = createApp({ dataSource: 'fixture' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sso/login`, { redirect: 'manual' });
    const state = new URL(loginRes.headers.get('location')).searchParams.get('state');
    const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const callbackRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { cookie } },
    );
    const code = new URL(callbackRes.headers.get('location')).searchParams.get('code');
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sso/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.data.accessToken);
    const payload = JSON.parse(Buffer.from(body.data.accessToken.split('.')[1], 'base64url').toString());
    assert.equal(payload.sub, '22222222-2222-2222-2222-222222222222');
    assert.equal(payload.national_id, undefined);
  } finally {
    server.close();
    Object.assign(config.sso, previousSso);
    config.app.url = previousAppUrl;
    delete process.env.SSO_PROVIDER;
  }
});
