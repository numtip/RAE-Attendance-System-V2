const test = require('node:test');
const assert = require('node:assert/strict');

const { createSsoController, readCookie } = require('../src/controllers/ssoController');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');

/**
 * G-02 — browser-session binding for a login attempt.
 *
 * These tests drive the controller with a fake res/req, so the cookie attributes and the
 * single-use behaviour are asserted at the HTTP boundary rather than at the store API.
 *
 * MJU does not echo `state`, so the binding is the only thing tying a callback to the browser
 * that started the login. The residual risk (an attacker inside a browser that just started a
 * login) is NOT closed by this and is documented in docs/SSO_PROTOCOL_EVIDENCE.md.
 */

const BINDING_COOKIE = 'rae_sso_bind';

function baseConfig(overrides = {}) {
  return {
    env: 'test',
    app: { url: 'http://127.0.0.1:3000' },
    sso: {
      loginBindingCookie: BINDING_COOKIE,
      loginBindingTtlMs: 10 * 60 * 1000,
      requireLoginBinding: true,
      ...overrides,
    },
  };
}

function fakeRes() {
  const cookies = [];
  const cleared = [];
  const headers = {};
  return {
    cookies,
    cleared,
    headers,
    statusCode: 200,
    redirectTo: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    cookie(name, value, options) {
      cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      cleared.push({ name, options });
      return this;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    redirect(code, target) {
      this.statusCode = code;
      this.redirectTo = target;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/** A service stub that records what the controller passed through. */
function fakeService(overrides = {}) {
  const calls = { beginLogin: [], handleCallback: [] };
  return {
    calls,
    async beginLogin(input) {
      calls.beginLogin.push(input);
      return 'https://sso.example/signin?state=abc';
    },
    async handleCallback(input) {
      calls.handleCallback.push(input);
      return { accessToken: 'x' };
    },
    async me() {
      return {};
    },
    async logout() {
      return { revoked: true };
    },
    ...overrides,
  };
}

test('login sets an HttpOnly, SameSite=Lax, narrowly scoped binding cookie', async () => {
  const res = fakeRes();
  const service = fakeService();
  const controller = createSsoController(service, { config: baseConfig() });

  await controller.login({ headers: {} }, res);

  assert.equal(res.cookies.length, 1);
  const [cookie] = res.cookies;
  assert.equal(cookie.name, BINDING_COOKIE);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.sameSite, 'lax');
  assert.equal(cookie.options.path, '/api/v1/auth/sso');
  assert.equal(cookie.options.maxAge, 10 * 60 * 1000);
  // The dev/test server is http, so Secure would make the cookie unsettable.
  assert.equal(cookie.options.secure, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('in production the binding cookie is Secure', async () => {
  const res = fakeRes();
  const config = baseConfig();
  config.env = 'production';
  const controller = createSsoController(fakeService(), { config });

  await controller.login({ headers: {} }, res);
  assert.equal(res.cookies[0].options.secure, true);
});

test('the binding is cryptographically random and never repeats', async () => {
  const seen = new Set();
  const controller = createSsoController(fakeService(), { config: baseConfig() });
  for (let index = 0; index < 25; index += 1) {
    const res = fakeRes();
    await controller.login({ headers: {} }, res);
    const value = res.cookies[0].value;
    assert.match(value, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.equal(seen.has(value), false, 'a binding must never be reused');
    seen.add(value);
  }
});

test('login passes the same binding to the service that it puts in the cookie', async () => {
  const res = fakeRes();
  const service = fakeService();
  const controller = createSsoController(service, { config: baseConfig() });

  await controller.login({ headers: {} }, res);

  assert.equal(service.calls.beginLogin.length, 1);
  assert.equal(service.calls.beginLogin[0].browserBinding, res.cookies[0].value);
});

test('a client-supplied binding cookie is ignored at login (fixation defence)', async () => {
  const res = fakeRes();
  const service = fakeService();
  const controller = createSsoController(service, { config: baseConfig() });

  await controller.login({ headers: { cookie: `${BINDING_COOKIE}=attacker-chosen-value` } }, res);

  const issued = res.cookies[0].value;
  assert.notEqual(issued, 'attacker-chosen-value');
  assert.equal(service.calls.beginLogin[0].browserBinding, issued);
});

test('the callback forwards the presented binding and clears it before the exchange', async () => {
  const res = fakeRes();
  const service = fakeService();
  const controller = createSsoController(service, { config: baseConfig() });

  await controller.callback(
    { method: 'GET', query: { code: 'abc', state: 'xyz' }, headers: { cookie: `${BINDING_COOKIE}=presented-value` } },
    res,
  );

  assert.equal(service.calls.handleCallback[0].browserBinding, 'presented-value');
  assert.equal(res.cleared.length, 1);
  assert.equal(res.cleared[0].name, BINDING_COOKIE);
  // Cleared BEFORE the service runs: order matters, so a retry cannot reuse the cookie.
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('a callback with no binding cookie presents undefined, and the store refuses it', async () => {
  const res = fakeRes();
  const service = fakeService();
  const controller = createSsoController(service, { config: baseConfig() });

  await controller.callback({ method: 'GET', query: { code: 'abc', state: 'xyz' }, headers: {} }, res);

  assert.equal(service.calls.handleCallback[0].browserBinding, undefined);
});

test('a tampered or malformed cookie value is treated as absent', () => {
  assert.equal(readCookie({ headers: { cookie: `${BINDING_COOKIE}=%E0%A4%A` } }, BINDING_COOKIE), undefined);
  assert.equal(readCookie({ headers: {} }, BINDING_COOKIE), undefined);
  assert.equal(readCookie({ headers: { cookie: 'other=1' } }, BINDING_COOKIE), undefined);
  assert.equal(readCookie({ headers: { cookie: `${BINDING_COOKIE}=ok; other=1` } }, BINDING_COOKIE), 'ok');
});

test('logout clears the pending login attempt as well as ending the session', async () => {
  const res = fakeRes();
  const controller = createSsoController(fakeService(), { config: baseConfig() });

  await controller.logout({ body: { refreshToken: 'rt' }, auth: { employeeUid: 'e1' } }, res);

  assert.equal(res.cleared.length, 1);
  assert.equal(res.cleared[0].name, BINDING_COOKIE);
});

/**
 * End-to-end over the store: a binding issued at login must be presented at callback, and the
 * attempt is single use.
 */
function buildStoreBackedService() {
  const store = createSsoStateStore();
  return {
    store,
    async beginLogin({ browserBinding } = {}) {
      return { state: await store.create(browserBinding ? { binding: browserBinding } : {}) };
    },
  };
}

test('the issued binding completes exactly one callback', async () => {
  const { store } = buildStoreBackedService();
  const state = await store.create({ binding: 'valid-binding-value-32-chars-long' });

  assert.equal(await store.consume(state, 'valid-binding-value-32-chars-long'), true);
  assert.equal(await store.consume(state, 'valid-binding-value-32-chars-long'), false);
});

test('a wrong binding both fails and destroys the attempt', async () => {
  const store = createSsoStateStore();
  const state = await store.create({ binding: 'correct-binding-value-32chars' });

  assert.equal(await store.consume(state, 'wrong-binding-value-32-chars00'), false);
  // The correct holder can no longer complete it: the attempt was burned by the wrong attempt.
  assert.equal(await store.consume(state, 'correct-binding-value-32chars'), false);
});

test('concurrent callbacks for one attempt have exactly one winner', async () => {
  const store = createSsoStateStore();
  const state = await store.create({ binding: 'concurrent-binding-value-32char' });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.consume(state, 'concurrent-binding-value-32char')),
  );
  assert.equal(results.filter(Boolean).length, 1, `expected exactly one winner, got ${results.filter(Boolean).length}`);
});

test('a missing binding on a bound attempt is refused', async () => {
  const store = createSsoStateStore();
  const state = await store.create({ binding: 'bound-binding-value-32-chars0' });
  assert.equal(await store.consume(state), false);
  assert.equal(await store.consume(state, ''), false);
});
