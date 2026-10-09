require('./helpers/syntheticIdentifierKeys');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const config = require('../src/config');
const { createApp } = require('../src/app');
const { createSsoService } = require('../src/services/ssoService');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');
const { createSsoLoginCodeStore } = require('../src/services/sso/ssoLoginCodeStore');
const { createSsoController } = require('../src/controllers/ssoController');
const { authenticate } = require('../src/middleware/authenticate');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { HttpError } = require('../src/utils/httpError');
const { TEST_BINDING } = require('./helpers/ssoTestBinding');

// Synthetic identity of the dev fixture user (employee 2222...). No real data.
const USER_UID = '22222222-2222-2222-2222-222222222222';
const USER_NATIONAL = '9900000000001';
const OTHER_BINDING = 'another-browser-binding-fedcba9876543210';

const jwtConfig = { secret: process.env.JWT_SECRET, expiresIn: '15m', refreshTokenDays: 14 };

function ssoConfig(overrides = {}) {
  return {
    enabled: true,
    callbackConfirmed: true,
    protocolContractConfirmed: true,
    subjectContractConfirmed: true,
    provider: 'http',
    scopes: 'profile',
    authorizationUrl: 'https://sso.example.test/oauth/authorize',
    tokenUrl: 'https://sso.example.test/oauth/token',
    userInfoUrl: 'https://sso.example.test/oauth/userinfo',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
    nationalIdClaims: 'citizenID',
    pkceMethod: '',
    ...overrides,
  };
}

/** Scripted provider: records every call; each code maps to a distinct synthetic access token. */
function scriptedProvider({ tokenResponse, profile, verifyPkce = false } = {}) {
  const calls = { exchange: [], userinfo: [], urls: [] };
  const challenges = new Map();
  return {
    calls,
    kind: 'scripted',
    buildAuthorizationUrl({ authorizationUrl, state, codeChallenge }) {
      const url = new URL(authorizationUrl);
      url.searchParams.set('state', state);
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
        challenges.set(state, codeChallenge);
      }
      calls.urls.push(url.toString());
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier }) {
      calls.exchange.push({ code, codeVerifier });
      if (verifyPkce) {
        const challenge = [...challenges.values()].find((value) => value === createHash('sha256').update(String(codeVerifier)).digest('base64url'));
        if (!challenge) throw new HttpError(401, 'SSO_TOKEN_ERROR', 'PKCE verification failed');
      }
      return tokenResponse ? tokenResponse(code) : { access_token: `access-for-${code}`, token_type: 'Bearer' };
    },
    async fetchUserInfo({ accessToken }) {
      calls.userinfo.push(accessToken);
      if (!String(accessToken).startsWith('access-for-')) {
        throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request');
      }
      return profile ? profile(accessToken) : { sub: 'syn-subject-1', citizenID: USER_NATIONAL };
    },
  };
}

function build({ provider = scriptedProvider(), sso = {}, stateStore = createSsoStateStore(), loginCodeStore } = {}) {
  const repositories = createFixtureRepositories();
  const service = createSsoService({
    config: { jwt: jwtConfig, sso: ssoConfig(sso) },
    repositories,
    oauthProvider: provider,
    stateStore,
    ...(loginCodeStore ? { loginCodeStore } : {}),
  });
  return { service, provider, repositories, stateStore };
}

async function begin(service, browserBinding = TEST_BINDING) {
  const url = await service.beginLogin({ browserBinding });
  return new URL(url).searchParams.get('state');
}

const stateInvalid = (e) => e.status === 403 && e.code === 'SSO_STATE_INVALID';

// ---------------------------------------------------------------------------------------------- CSRF

test('login CSRF: a state started in another browser is rejected before any provider call and is burned', async () => {
  const { service, provider } = build();
  const attackerState = await begin(service, TEST_BINDING); // attacker starts a login in their own browser
  // The victim's browser carries a different binding (or none) when the attacker lures it to the callback.
  await assert.rejects(() => service.handleCallback({ code: 'attacker-code', state: attackerState, browserBinding: OTHER_BINDING }), stateInvalid);
  await assert.rejects(() => service.handleCallback({ code: 'attacker-code', state: attackerState }), stateInvalid);
  // The state is spent: even the attacker's own browser cannot finish this login now.
  await assert.rejects(() => service.handleCallback({ code: 'attacker-code', state: attackerState, browserBinding: TEST_BINDING }), stateInvalid);
  assert.equal(provider.calls.exchange.length, 0, 'the authorization code is never exchanged');
  assert.equal(provider.calls.userinfo.length, 0);
});

test('state binding is mandatory when the login starts (no unbound state can be minted)', async () => {
  const { service } = build();
  await assert.rejects(() => service.beginLogin(), (e) => e.status === 500 && e.code === 'SSO_STATE_BINDING_REQUIRED');
  await assert.rejects(() => service.beginLogin({ browserBinding: 'short' }), (e) => e.code === 'SSO_STATE_BINDING_REQUIRED');
});

// -------------------------------------------------------------------------------- replay / expiry / shape

test('state replay: the second use of a state is rejected and never reaches the provider', async () => {
  const { service, provider } = build();
  const state = await begin(service);
  const session = await service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING });
  assert.ok(session.accessToken);
  await assert.rejects(() => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING }), stateInvalid);
  assert.equal(provider.calls.exchange.length, 1);
});

test('expired state is rejected without contacting the provider', async () => {
  let nowMs = 1_000_000;
  const stateStore = createSsoStateStore({ ttlMs: 10 * 60 * 1000, now: () => nowMs });
  const { service, provider } = build({ stateStore });
  const state = await begin(service);
  nowMs += 10 * 60 * 1000 + 1;
  await assert.rejects(() => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING }), stateInvalid);
  assert.equal(provider.calls.exchange.length, 0);
});

test('malformed callback parameters are rejected (arrays, objects, empty, oversized, missing)', async () => {
  const { service, provider } = build();
  const state = await begin(service);
  const b = { browserBinding: TEST_BINDING };
  await assert.rejects(() => service.handleCallback({ code: ['a', 'b'], state, ...b }), (e) => e.status === 400);
  await assert.rejects(() => service.handleCallback({ code: { $ne: 1 }, state, ...b }), (e) => e.status === 400);
  await assert.rejects(() => service.handleCallback({ code: '', state, ...b }), (e) => e.status === 400);
  await assert.rejects(() => service.handleCallback({ code: 'x'.repeat(5000), state, ...b }), (e) => e.status === 400);
  await assert.rejects(() => service.handleCallback({ code: 'c', state: [state], ...b }), stateInvalid);
  await assert.rejects(() => service.handleCallback({ code: 'c', state: 'z'.repeat(1000), ...b }), stateInvalid);
  await assert.rejects(() => service.handleCallback({ code: 'c', ...b }), stateInvalid);
  assert.equal(provider.calls.exchange.length, 0);
  // None of the malformed attempts consumed the genuine state.
  const session = await service.handleCallback({ code: 'good', state, ...b });
  assert.ok(session.refreshToken);
});

test('provider error responses are bounded and never reflect an unbounded string', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.handleCallback({ error: 'access_denied', error_description: 'x'.repeat(5000) }),
    (e) => e.status === 401 && e.code === 'SSO_DENIED' && e.message.length <= 200,
  );
});

test('state store is bounded: unauthenticated /login traffic cannot grow it without limit', () => {
  const store = createSsoStateStore({ maxPending: 5 });
  const states = Array.from({ length: 20 }, () => store.create({ binding: TEST_BINDING }));
  assert.equal(store.consume(states[0], TEST_BINDING), null, 'oldest states were evicted');
  assert.ok(store.consume(states[19], TEST_BINDING), 'newest state is still valid');
});

// ----------------------------------------------------------------------------------- token substitution

test('token substitution: identity comes only from userinfo fetched with THIS exchange\'s access token', async () => {
  const provider = scriptedProvider({
    tokenResponse: () => ({
      access_token: 'access-for-genuine',
      token_type: 'Bearer',
      // A forged id_token claiming another person. MJU has not confirmed OIDC, so it must be ignored entirely.
      id_token: jwt.sign({ sub: 'victim-subject', citizenID: '9900000000099' }, 'attacker-key'),
    }),
    profile: (token) => (token === 'access-for-genuine' ? { sub: 'syn-subject-1', citizenID: USER_NATIONAL } : { sub: 'victim-subject', citizenID: '9900000000099' }),
  });
  const { service } = build({ provider });
  const state = await begin(service);
  const session = await service.handleCallback({
    code: 'c1',
    state,
    browserBinding: TEST_BINDING,
    // Hostile values smuggled in the callback query must not be used as a token or as identity.
    rawQuery: { access_token: 'access-for-evil', id_token: 'forged', sub: 'victim-subject', citizenID: '9900000000099', code: 'c1', state },
  });
  assert.deepEqual(provider.calls.userinfo, ['access-for-genuine']);
  assert.equal(session.employee.employeeUid, USER_UID);
});

test('token response validation: wrong token type, missing or non-string token, and non-object userinfo fail closed', async () => {
  for (const [label, tokenResponse, code] of [
    ['mac token type', { access_token: 'access-for-x', token_type: 'mac' }, 'SSO_TOKEN_ERROR'],
    ['missing access_token', { token_type: 'Bearer' }, 'SSO_TOKEN_ERROR'],
    ['object access_token', { access_token: { a: 1 }, token_type: 'Bearer' }, 'SSO_TOKEN_ERROR'],
    ['empty access_token', { access_token: '', token_type: 'Bearer' }, 'SSO_TOKEN_ERROR'],
    ['null response', null, 'SSO_TOKEN_ERROR'],
  ]) {
    const provider = scriptedProvider({ tokenResponse: () => tokenResponse });
    const { service } = build({ provider });
    const state = await begin(service);
    await assert.rejects(() => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING }), (e) => e.status === 502 && e.code === code, label);
    assert.equal(provider.calls.userinfo.length, 0, `${label}: userinfo is never called`);
  }
  for (const document of [[], 'text', null]) {
    const provider = scriptedProvider({ profile: () => document });
    const { service } = build({ provider });
    const state = await begin(service);
    await assert.rejects(() => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING }), (e) => e.status === 502 && e.code === 'SSO_PROVIDER_ERROR');
  }
});

test('a lowercase "bearer" token type is accepted (case-insensitive per RFC 6750)', async () => {
  const { service } = build({ provider: scriptedProvider({ tokenResponse: () => ({ access_token: 'access-for-x', token_type: 'bearer' }) }) });
  const state = await begin(service);
  assert.ok((await service.handleCallback({ code: 'c', state, browserBinding: TEST_BINDING })).accessToken);
});

// ------------------------------------------------------------------- invalid signature (our session token)

function runAuthenticate(token) {
  const previous = config.jwt.secret;
  config.jwt.secret = process.env.JWT_SECRET;
  try {
    let outcome;
    authenticate({ get: () => (token ? `Bearer ${token}` : '') }, {}, (err) => { outcome = err || 'ok'; });
    return outcome;
  } finally {
    config.jwt.secret = previous;
  }
}

test('session token signature: forged, tampered, alg=none, wrong algorithm and expired tokens are all refused', async () => {
  const { service } = build();
  const state = await begin(service);
  const session = await service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING });
  assert.equal(runAuthenticate(session.accessToken), 'ok', 'the genuine token is accepted');

  const claims = { role: 'admin', email: 'user@example.test', authMethod: 'sso' };
  const forged = jwt.sign(claims, 'not-the-server-secret', { subject: USER_UID, expiresIn: '15m' });
  const wrongAlg = jwt.sign(claims, process.env.JWT_SECRET, { subject: USER_UID, expiresIn: '15m', algorithm: 'HS512' });
  const expired = jwt.sign(claims, process.env.JWT_SECRET, { subject: USER_UID, expiresIn: -10 });
  const [h, p, s] = session.accessToken.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin', sub: '11111111-1111-1111-1111-111111111111' })).toString('base64url');
  const algNone = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
  for (const [label, token] of [['forged', forged], ['wrong algorithm', wrongAlg], ['expired', expired], ['tampered payload', `${h}.${tamperedPayload}.${s}`], ['alg none', algNone], ['empty signature', `${h}.${p}.`], ['missing', '']]) {
    const outcome = runAuthenticate(token);
    assert.ok(outcome instanceof HttpError && outcome.status === 401, label);
  }
});

test('every login yields a unique access token id (no deterministic or reusable session token)', async () => {
  const { service } = build();
  const tokens = [];
  for (let i = 0; i < 3; i += 1) {
    const state = await begin(service);
    tokens.push((await service.handleCallback({ code: `c${i}`, state, browserBinding: TEST_BINDING })).accessToken);
  }
  assert.equal(new Set(tokens).size, 3);
  assert.equal(new Set(tokens.map((token) => jwt.decode(token).jti)).size, 3);
});

// --------------------------------------------------------------------------- session fixation / handoff

test('session fixation: tokens are minted fresh per login and the handoff code is single use', async () => {
  const loginCodeStore = createSsoLoginCodeStore();
  const { service, repositories } = build({ loginCodeStore });
  const state1 = await begin(service);
  const first = await service.handleCallback({ code: 'c1', state: state1, browserBinding: TEST_BINDING });
  const state2 = await begin(service);
  const second = await service.handleCallback({ code: 'c2', state: state2, browserBinding: TEST_BINDING });
  assert.notEqual(first.refreshToken, second.refreshToken);
  assert.notEqual(first.accessToken, second.accessToken);

  const handoff = service.issueLoginHandoff(first);
  assert.ok(service.exchangeLoginHandoff({ code: handoff }).refreshToken);
  assert.throws(() => service.exchangeLoginHandoff({ code: handoff }), (e) => e.status === 401 && e.code === 'SSO_HANDOFF_INVALID');
  // A client cannot choose or pre-set the tokens: nothing in the callback input influences them.
  const stored = await repositories.refreshTokens.find(first.refreshToken);
  assert.equal(stored.employeeUid, USER_UID);
});

test('handoff code expires and a guessed code is refused', async () => {
  let nowMs = 5_000;
  const loginCodeStore = createSsoLoginCodeStore({ ttlMs: 45_000, now: () => nowMs });
  const { service } = build({ loginCodeStore });
  const state = await begin(service);
  const session = await service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING });
  const handoff = service.issueLoginHandoff(session);
  nowMs += 45_001;
  assert.throws(() => service.exchangeLoginHandoff({ code: handoff }), (e) => e.code === 'SSO_HANDOFF_EXPIRED');
  assert.throws(() => service.exchangeLoginHandoff({ code: 'a'.repeat(48) }), (e) => e.code === 'SSO_HANDOFF_INVALID');
});

function fakeRes() {
  const res = { headers: {}, cookies: [], cleared: [], redirected: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.cookie = (name, value, options) => { res.cookies.push({ name, value, options }); return res; };
  res.clearCookie = (name, options) => { res.cleared.push({ name, options }); return res; };
  res.redirect = (status, url) => { res.redirected = { status, url }; return res; };
  return res;
}

/** asyncRoute does not return its promise: settle on redirect or next(err). */
function invoke(handler, req, res) {
  return new Promise((resolve) => {
    const originalRedirect = res.redirect;
    res.redirect = (...args) => { originalRedirect(...args); resolve(null); return res; };
    handler(req, res, (err) => resolve(err || null));
  });
}

test('controller: binding cookie is server generated, HttpOnly, SameSite=Lax, scoped, Secure in production; request cookies are never reused', async () => {
  for (const [env, secure] of [['production', true], ['development', false]]) {
    const seen = [];
    const controller = createSsoController(
      { beginLogin: async ({ browserBinding }) => { seen.push(browserBinding); return 'https://sso.example.test/authorize?state=s'; } },
      { config: { env, app: { url: 'https://app.example.test' } } },
    );
    const res = fakeRes();
    assert.equal(await invoke(controller.login, { headers: { cookie: 'rae_sso_bind=attacker-chosen-value-0000000000' } }, res), null);
    assert.equal(res.cookies.length, 1);
    const [{ name, value, options }] = res.cookies;
    assert.equal(name, 'rae_sso_bind');
    assert.notEqual(value, 'attacker-chosen-value-0000000000', 'a client-supplied binding is never adopted (fixation)');
    assert.equal(value, seen[0]);
    assert.match(value, /^[0-9a-f]{48}$/);
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.secure, secure);
    assert.equal(options.path, '/api/v1/auth/sso');
    assert.ok(options.maxAge <= 10 * 60 * 1000);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('controller: callback forwards the cookie binding, clears it whatever the outcome, and sets no-referrer/no-store', async () => {
  let received;
  const controller = createSsoController(
    {
      handleCallback: async (input) => { received = input; throw new HttpError(403, 'SSO_STATE_INVALID', 'nope'); },
      issueLoginHandoff: () => 'handoff',
    },
    { config: { env: 'production', app: { url: 'https://app.example.test' } } },
  );
  const res = fakeRes();
  const err = await invoke(controller.callback, { headers: { cookie: 'a=1; rae_sso_bind=bound-value; rae_sso_bind=dup' }, query: { code: 'c', state: 's' }, method: 'GET', body: {} }, res);
  assert.equal(err.code, 'SSO_STATE_INVALID');
  assert.equal(received.browserBinding, 'bound-value', 'first cookie wins; duplicates are ignored');
  assert.equal(res.cleared.length, 1, 'binding cookie cleared even though the callback failed');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

async function fetchCookieFlow(port, cookieHeader) {
  const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sso/login`, { redirect: 'manual', headers: cookieHeader ? { cookie: cookieHeader } : {} });
  return { status: login.status, location: login.headers.get('location'), setCookie: login.headers.getSetCookie() };
}

test('HTTP: attacker-supplied binding cookie is replaced; login CSRF over HTTP is rejected; the real browser succeeds once', async () => {
  const previousSso = { ...config.sso };
  const previousAppUrl = config.app.url;
  Object.assign(config.sso, ssoConfig({ provider: 'mock' }));
  config.app.url = 'http://127.0.0.1:3100';
  const server = http.createServer(createApp({ dataSource: 'fixture' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const attacker = await fetchCookieFlow(port, 'rae_sso_bind=attacker-chosen-value-0000000000');
    assert.equal(attacker.status, 302);
    assert.equal(attacker.setCookie.length, 1);
    assert.match(attacker.setCookie[0], /^rae_sso_bind=[0-9a-f]{48}; /);
    assert.match(attacker.setCookie[0], /HttpOnly/i);
    assert.match(attacker.setCookie[0], /SameSite=Lax/i);
    assert.doesNotMatch(attacker.setCookie[0], /attacker-chosen/);
    const attackerState = new URL(attacker.location).searchParams.get('state');
    const callbackUrl = `http://127.0.0.1:${port}/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(attackerState)}`;

    // Victim browser: different (or no) cookie -> rejected.
    const victim = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: 'rae_sso_bind=victim-browser-value-1111111111' } });
    assert.equal(victim.status, 403);
    assert.match(victim.headers.get('set-cookie') || '', /rae_sso_bind=;/);
    assert.equal(victim.headers.get('referrer-policy'), 'no-referrer');
    const noCookie = await fetch(callbackUrl, { redirect: 'manual' });
    assert.equal(noCookie.status, 403);

    // A fresh, genuine round trip with the cookie issued by the server works exactly once.
    const real = await fetchCookieFlow(port);
    const state = new URL(real.location).searchParams.get('state');
    const cookie = real.setCookie.map((c) => c.split(';')[0]).join('; ');
    const url = `http://127.0.0.1:${port}/api/v1/auth/sso/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`;
    const ok = await fetch(url, { redirect: 'manual', headers: { cookie } });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('location'), /\/auth\/sso\/complete\?code=/);
    const replay = await fetch(url, { redirect: 'manual', headers: { cookie } });
    assert.equal(replay.status, 403);
  } finally {
    server.close();
    Object.assign(config.sso, previousSso);
    config.app.url = previousAppUrl;
  }
});

// ------------------------------------------------------------------------------------ concurrent login

test('concurrent callbacks sharing one state: exactly one wins, the provider is called once', async () => {
  const { service, provider } = build();
  const state = await begin(service);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && stateInvalid(r.reason)).length, 9);
  assert.equal(provider.calls.exchange.length, 1);
});

test('concurrent logins of the same employee from different browsers get independent sessions', async () => {
  const loginCodeStore = createSsoLoginCodeStore();
  const { service } = build({ loginCodeStore });
  const bindings = Array.from({ length: 20 }, (_, i) => `browser-binding-${String(i).padStart(2, '0')}-0123456789abcdef`);
  const states = await Promise.all(bindings.map((binding) => begin(service, binding)));
  const sessions = await Promise.all(states.map((state, i) => service.handleCallback({ code: `code-${i}`, state, browserBinding: bindings[i] })));
  assert.equal(new Set(sessions.map((s) => s.refreshToken)).size, 20);
  assert.equal(new Set(sessions.map((s) => s.accessToken)).size, 20);
  assert.ok(sessions.every((s) => s.employee.employeeUid === USER_UID));
  // Cross-wiring check: a binding only unlocks its own state.
  const [s1, s2] = await Promise.all([begin(service, bindings[0]), begin(service, bindings[1])]);
  await assert.rejects(() => service.handleCallback({ code: 'x', state: s1, browserBinding: bindings[1] }), stateInvalid);
  assert.ok(await service.handleCallback({ code: 'y', state: s2, browserBinding: bindings[1] }));
  // Each handoff is independent and single use.
  const handoffs = sessions.map((session) => service.issueLoginHandoff(session));
  assert.equal(new Set(handoffs).size, 20);
  const exchanged = handoffs.map((code) => service.exchangeLoginHandoff({ code }));
  assert.equal(new Set(exchanged.map((r) => r.refreshToken)).size, 20);
});

// ------------------------------------------------------------------------------------------------ PKCE

test('PKCE is off by default (no unconfirmed parameter is sent to MJU)', async () => {
  const { service, provider } = build();
  const state = await begin(service);
  assert.doesNotMatch(provider.calls.urls[0], /code_challenge/);
  await service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING });
  assert.equal(provider.calls.exchange[0].codeVerifier, undefined);
});

test('PKCE S256 (opt-in): challenge in the URL, verifier only in the back-channel exchange, bound to the state', async () => {
  const provider = scriptedProvider({ verifyPkce: true });
  const { service } = build({ provider, sso: { pkceMethod: 'S256' } });
  const state = await begin(service);
  const url = new URL(provider.calls.urls[0]);
  const challenge = url.searchParams.get('code_challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  await service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING });
  const { codeVerifier } = provider.calls.exchange[0];
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(codeVerifier).digest('base64url'), challenge);
  assert.doesNotMatch(provider.calls.urls[0], new RegExp(codeVerifier), 'verifier never appears in the browser-visible URL');
});

// ----------------------------------------------------------------------------- fail-closed contract gates

test('defaults: the OAuth protocol contract and PKCE are off in the shipped configuration', () => {
  assert.equal(config.sso.protocolContractConfirmed, false);
  assert.equal(config.sso.pkceMethod, '');
  assert.equal(config.sso.enabled, false);
});

test('unconfirmed protocol: login and callback refuse before any state, redirect or provider call', async () => {
  const provider = scriptedProvider();
  const { service } = build({ provider, sso: { protocolContractConfirmed: false } });
  await assert.rejects(() => service.beginLogin({ browserBinding: TEST_BINDING }), (e) => e.status === 503 && e.code === 'SSO_NOT_READY');
  await assert.rejects(() => service.handleCallback({ code: 'c', state: 's', browserBinding: TEST_BINDING }), (e) => e.status === 503 && e.code === 'SSO_NOT_READY');
  assert.equal(provider.calls.urls.length + provider.calls.exchange.length + provider.calls.userinfo.length, 0);
});

test('portal callback (the only confirmed MJU transport): a bare `ac` value never creates a session, even if the OAuth contract flag is set', async () => {
  const provider = scriptedProvider();
  const { service } = build({
    provider,
    sso: { signinUrl: 'https://sso.mju.ac.th/signin.aspx', signoutUrl: 'https://sso.mju.ac.th/signout.aspx' },
  });
  await assert.rejects(
    () => service.handleCallback({ rawQuery: { ac: 'a'.repeat(32) }, code: undefined, state: undefined, browserBinding: TEST_BINDING }),
    (e) => e.status === 503 && e.code === 'SSO_NOT_READY',
  );
  assert.equal(provider.calls.exchange.length, 0);
});

test('live provider without an operator-confirmed citizen ID claim name fails closed before any identity lookup', async () => {
  const { service, repositories } = build({ sso: { nationalIdClaims: '' } });
  const state = await begin(service);
  await assert.rejects(
    () => service.handleCallback({ code: 'c1', state, browserBinding: TEST_BINDING }),
    (e) => e.status === 503 && e.code === 'SSO_NOT_READY' && /citizen ID claim/.test(e.message),
  );
  assert.equal(await repositories.refreshTokens.find('anything'), null);
});
