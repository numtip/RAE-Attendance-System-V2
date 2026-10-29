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
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const LINKED_EMPLOYEE_UID = '22222222-2222-2222-2222-222222222222';

// Approve (or leave pending) an identity link, so the live path has something to resolve.
async function linkSubject(repositories, subject, { approve = true, employeeUid = LINKED_EMPLOYEE_UID } = {}) {
  const identity = createIdentityResolutionService({ repositories });
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid,
    emailSnapshot: 'user@example.test',
    confidence: 'high',
    source: 'operator_review',
  });
  if (!approve) return candidate;
  return identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
}

// Counts session minting attempts, so a denial test can prove no token was issued.
function countRefreshSaves(repositories) {
  const original = repositories.refreshTokens.save.bind(repositories.refreshTokens);
  const counter = { count: 0 };
  repositories.refreshTokens.save = async (row) => {
    counter.count += 1;
    return original(row);
  };
  return counter;
}

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
  // The fixture asserts the subject-contract switch so the exchange mechanics can be exercised
  // against the fake HTTP provider. Production keeps SSO_SUBJECT_CONTRACT_CONFIRMED=false, and
  // assertSsoGate refuses every non-mock provider while it is false (see the dedicated test).
  subjectContractConfirmed: true,
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

async function rawGet(port, path, { cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : undefined,
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie: response.headers.getSetCookie?.() ?? [],
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

test('contract: the unauthenticated signout endpoint stays closed while SSO is disabled', () => {
  // Signout is a bare GET, so it must obey the same gate as every other SSO entry point: with SSO off, nobody
  // gets redirected to the IdP, and the client ID stays out of a public Location header.
  const ssoService = createEnabledSsoService({
    ssoConfig: {
      enabled: false,
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      clientId: 'a46a0b5374b4404a9f71a2397dcab283',
      callbackUrl: 'https://raeservice.mju.ac.th/api/v1/auth/sso/callback',
    },
  });
  assert.throws(() => ssoService.signoutRedirect(), (err) => err.code === 'SSO_DISABLED');
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

test('live login is refused while the subject contract is unconfirmed (default posture)', async () => {
  // The shipped default is SSO_PROVIDER=http with SSO_SUBJECT_CONTRACT_CONFIRMED=false. Without
  // this gate the live callback would authenticate whoever owns a matching e-mail address and
  // would never consult an approved identity link (policy S7, S3/S6).
  const service = createSsoService({
    config: {
      jwt: baseJwtConfig,
      sso: { ...baseSsoConfig, provider: 'http', subjectContractConfirmed: false },
    },
    repositories: createFixtureRepositories(),
    oauthProvider: createMockOAuthProvider(),
    stateStore: createSsoStateStore(),
  });

  await assert.rejects(
    () => service.beginLogin({ browserBinding: 'b'.repeat(32) }),
    (err) => err.status === 503 && err.code === 'SSO_SUBJECT_CONTRACT_UNCONFIRMED',
  );
  await assert.rejects(
    () => service.handleCallback({ code: 'any-code', state: 'any-state' }),
    (err) => err.status === 503 && err.code === 'SSO_SUBJECT_CONTRACT_UNCONFIRMED',
  );
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

test('contract: live callback issues tokens only through an approved identity link', async () => {
  const repositories = createFixtureRepositories();
  await linkSubject(repositories, 'mju-approved-subject-1');
  const session = await callbackWithFetch([
    { body: { access_token: 'provider-token', token_type: 'Bearer' } },
    { body: { sub: 'mju-approved-subject-1' } },
  ], repositories);
  assert.equal(session.employee.employeeUid, LINKED_EMPLOYEE_UID);
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
});

test('contract: live callback never issues a session from a profile e-mail', async () => {
  // The employee exists and the e-mail matches exactly - the old code authenticated here.
  const repositories = createFixtureRepositories();
  const saves = countRefreshSaves(repositories);
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { email: 'user@example.test' } },
    ], repositories),
    (err) => err.code === 'SSO_SUBJECT_INVALID' && /email_only/.test(err.message),
  );
  assert.equal(saves.count, 0, 'no refresh token may be minted for an e-mail identity');
});

test('contract: a confirmed subject contract does not bypass the approved-link gate', async () => {
  // baseSsoConfig sets subjectContractConfirmed: true; a verified-looking subject with no link
  // must still be refused.
  const repositories = createFixtureRepositories();
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { sub: 'mju-subject-without-link' } },
    ], repositories),
    (err) => err.code === 'IDENTITY_UNKNOWN',
  );
});

test('contract: a pending identity link is refused', async () => {
  const repositories = createFixtureRepositories();
  await linkSubject(repositories, 'mju-pending-subject', { approve: false });
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { sub: 'mju-pending-subject' } },
    ], repositories),
    (err) => err.code === 'IDENTITY_NOT_APPROVED',
  );
});

test('contract: missing claims reject the callback', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: {} },
    ]),
    (err) => err.code === 'SSO_SUBJECT_UNKNOWN',
  );
});

test('contract: missing employee mapping does not fall back to employee_id', async () => {
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { employee_id: 'E-USER' } },
    ]),
    (err) => err.code === 'SSO_SUBJECT_UNKNOWN',
  );
});

test('MJU signin and signout use only the cid parameter', async () => {
  const clientId = 'a46a0b5374b4404a9f71a2397dcab283';
  const repositories = createFixtureRepositories();
  const ssoConfig = {
    ...baseSsoConfig,
    provider: 'http',
    signinUrl: 'https://sso.mju.ac.th/signin.aspx',
    signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
    clientId,
    authorizationUrl: '',
    tokenUrl: '',
    userInfoUrl: '',
    clientSecret: '',
  };
  const ssoService = createSsoService({
    config: { jwt: baseJwtConfig, sso: ssoConfig },
    repositories,
  });
  const loginUrl = new URL(await ssoService.beginLogin());
  assert.equal(`${loginUrl.origin}${loginUrl.pathname}`, 'https://sso.mju.ac.th/signin.aspx');
  assert.deepEqual([...loginUrl.searchParams.keys()], ['cid']);
  assert.equal(loginUrl.searchParams.get('cid'), clientId);

  await assert.rejects(
    () => ssoService.handleCallback({ code: 'mock-auth-code', state: 'unused' }),
    (err) => err.code === 'SSO_NOT_READY',
  );

  const employee = await repositories.employees.findByEmail('user@example.test');
  await repositories.refreshTokens.save({
    token: 'portal-refresh',
    employeeUid: employee.employeeUid,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  });
  const loggedOut = await ssoService.logout({
    refreshToken: 'portal-refresh',
    auth: { employeeUid: employee.employeeUid },
  });
  const signoutUrl = new URL(loggedOut.signoutUrl);
  assert.equal(loggedOut.revoked, true);
  assert.equal(`${signoutUrl.origin}${signoutUrl.pathname}`, 'https://sso.mju.ac.th/signout.aspx');
  assert.deepEqual([...signoutUrl.searchParams.keys()], ['cid']);
  assert.equal(signoutUrl.searchParams.get('cid'), clientId);
});

test('contract: disabled employee with an approved link is rejected', async () => {
  const repositories = createFixtureRepositories();
  await linkSubject(repositories, 'mju-disabled-subject');
  const inactive = {
    employeeUid: LINKED_EMPLOYEE_UID,
    email: 'user@example.test',
    role: 'user',
    status: 'inactive',
    lockedUntil: null,
  };
  // Both lookups must agree: resolve reads the link owner by uid, then re-reads by e-mail.
  repositories.employees.findByUid = async () => inactive;
  repositories.employees.findByEmail = async () => inactive;
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { sub: 'mju-disabled-subject' } },
    ], repositories),
    (err) => err.code === 'SSO_USER_DISABLED',
  );
});

test('contract: an approved link whose e-mail evidence no longer matches is rejected', async () => {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 'mju-stale-email-subject',
    employeeUid: LINKED_EMPLOYEE_UID,
    emailSnapshot: 'someone-else@example.test',
    confidence: 'high',
    source: 'operator_review',
  });
  await identity.approve(candidate.id, {
    approvedBy: 'reviewer@example.test',
    acknowledgeEmailMismatch: true,
  });
  await assert.rejects(
    () => callbackWithFetch([
      { body: { access_token: 'provider-token' } },
      { body: { sub: 'mju-stale-email-subject' } },
    ], repositories),
    (err) => err.code === 'IDENTITY_EMAIL_MISMATCH',
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

test('a callback without the binding cookie is refused even with a valid state', async () => {
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
    const state = new URL(login.location).searchParams.get('state');

    // A valid state with no binding cookie: the login-CSRF case this control exists for.
    const noCookie = await rawGet(
      port,
      `/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(noCookie.status, 403);
    assert.equal(noCookie.body?.error?.code, 'SSO_STATE_INVALID');

    // The attempt was burned by the failed presentation, so even the right cookie cannot revive it.
    const bindingCookie = login.setCookie.find((value) => value.startsWith('rae_sso_bind='));
    const late = await rawGet(
      port,
      `/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
      { cookie: bindingCookie.split(';')[0] },
    );
    assert.equal(late.status, 403);
  } finally {
    Object.assign(config.sso, previous);
    delete process.env.SSO_PROVIDER;
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

    // G-02: the login attempt is bound to the browser. A real browser replays the cookie it was
    // given; a callback without it is refused (see the negative test below).
    const bindingCookie = login.setCookie.find((value) => value.startsWith('rae_sso_bind='));
    assert.ok(bindingCookie, 'login must set the binding cookie');

    const state = new URL(login.location).searchParams.get('state');
    const callback = await rawGet(
      port,
      `/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
      { cookie: bindingCookie.split(';')[0] },
    );
    assert.equal(callback.status, 302);
    assert.ok(callback.location.includes('sso=success'));
    // The binding is single use: the callback clears it.
    assert.ok(
      callback.setCookie.some((value) => value.startsWith('rae_sso_bind=;')),
      'the callback must clear the binding cookie',
    );
  } finally {
    Object.assign(config.sso, previous);
    delete process.env.SSO_PROVIDER;
    server.close();
  }
});

test('diagnostic callback lists unknown field names only and issues no session', async () => {
  const repositories = createFixtureRepositories();
  let saves = 0;
  const originalSave = repositories.refreshTokens.save.bind(repositories.refreshTokens);
  repositories.refreshTokens.save = async (...args) => {
    saves += 1;
    return originalSave(...args);
  };
  const rawEmail = 'person@example.test';
  const rawToken = 'sso-token-value-should-not-appear';
  const ssoService = createSsoService({
    config: {
      jwt: baseJwtConfig,
      sso: {
        ...baseSsoConfig,
        provider: 'http',
        signinUrl: 'https://sso.mju.ac.th/signin.aspx',
        signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
        clientId: 'a46a0b5374b4404a9f71a2397dcab283',
        authorizationUrl: '',
        tokenUrl: '',
        userInfoUrl: '',
        clientSecret: '',
        callbackDiagnostic: true,
      },
    },
    repositories,
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    await assert.rejects(
      () => ssoService.handleCallback({
        method: 'GET',
        cookieNames: ['session_name'],
        rawQuery: {
          unexpected_field: 'abc',
          sso_token: rawToken,
          email: rawEmail,
        },
        rawBody: { username: 'person-name' },
      }),
      (err) => {
        assert.equal(err.code, 'SSO_NOT_READY');
        assert.equal(err.status, 503);
        const packed = JSON.stringify(err.details);
        assert.equal(packed.includes(rawToken), false);
        assert.equal(packed.includes(rawEmail), false);
        assert.equal(packed.includes('person-name'), false);
        assert.equal(err.details.method, 'GET');
        assert.deepEqual(err.details.cookieNames, ['session_name']);
        assert.deepEqual(err.details.query.map((field) => field.name), [
          'email',
          'sso_token',
          'unexpected_field',
        ]);
        assert.deepEqual(err.details.body.map((field) => field.name), ['username']);
        const email = err.details.query.find((field) => field.name === 'email');
        assert.equal(email.type, 'email-shaped');
        assert.equal(email.length, rawEmail.length);
        const token = err.details.query.find((field) => field.name === 'sso_token');
        assert.equal(token.type, 'token-shaped');
        assert.equal(token.length, rawToken.length);
        return true;
      },
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(saves, 0);
  assert.equal(logs.join('\n').includes(rawToken), false);
  assert.equal(logs.join('\n').includes(rawEmail), false);
});

test('diagnostic login redirects while callback confirmation stays false', async () => {
  const ssoService = createEnabledSsoService({
    ssoConfig: {
      callbackConfirmed: false,
      callbackDiagnostic: true,
      provider: 'http',
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      clientId: 'a46a0b5374b4404a9f71a2397dcab283',
      authorizationUrl: '',
      tokenUrl: '',
      userInfoUrl: '',
      clientSecret: '',
    },
  });
  const loginUrl = new URL(await ssoService.beginLogin());
  assert.equal(`${loginUrl.origin}${loginUrl.pathname}`, 'https://sso.mju.ac.th/signin.aspx');
  assert.deepEqual([...loginUrl.searchParams.keys()], ['cid']);
  await assert.rejects(
    () => ssoService.me({ employeeUid: '22222222-2222-2222-2222-222222222222' }),
    (err) => err.code === 'SSO_NOT_READY',
  );
});

test('diagnostic mode stays off unless the flag is set and does not bypass SSO_DISABLED', async () => {
  const closed = createEnabledSsoService({
    ssoConfig: {
      provider: 'http',
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      callbackDiagnostic: false,
    },
  });
  await assert.rejects(
    () => closed.handleCallback({ rawQuery: { sso_token: 'raw-token-value-not-logged' } }),
    (err) => err.code === 'SSO_NOT_READY' && err.details == null,
  );

  const disabled = createEnabledSsoService({
    ssoConfig: { enabled: false, callbackDiagnostic: true },
  });
  await assert.rejects(
    () => disabled.handleCallback({ rawQuery: { email: 'person@example.test' } }),
    (err) => err.code === 'SSO_DISABLED' && err.details == null,
  );
});

test('diagnostic HTTP callback returns masked field metadata and no session', async () => {
  const previous = { ...config.sso };
  Object.assign(config.sso, {
    ...baseSsoConfig,
    provider: 'http',
    signinUrl: 'https://sso.mju.ac.th/signin.aspx',
    signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
    clientId: 'a46a0b5374b4404a9f71a2397dcab283',
    authorizationUrl: '',
    tokenUrl: '',
    userInfoUrl: '',
    clientSecret: '',
    callbackDiagnostic: true,
  });
  const rawToken = 'callback-token-must-stay-out-of-body';
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const response = await rawGet(
      port,
      `/api/v1/auth/sso/callback?unexpected_field=abc&sso_token=${encodeURIComponent(rawToken)}`,
    );
    const packed = JSON.stringify(response.body);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'SSO_NOT_READY');
    assert.equal(packed.includes(rawToken), false);
    assert.equal(response.body.error.details.method, 'GET');
    assert.deepEqual(response.body.error.details.cookieNames, []);
    assert.deepEqual(response.body.error.details.query.map((field) => field.name), [
      'sso_token',
      'unexpected_field',
    ]);
  } finally {
    Object.assign(config.sso, previous);
    config.sso.callbackDiagnostic = false;
    server.close();
  }
});
