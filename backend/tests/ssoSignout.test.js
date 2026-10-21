/**
 * Mock QA for the MJU SSO signout contract (C3).
 *
 * Everything here is synthetic: no network, no real MJU endpoint, no real identity. The sample client ID appears
 * only as a value that must be REJECTED.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SAMPLE_CLIENT_ID,
  assertNotSampleClientId,
  assertSignoutEndpoint,
  buildSignoutUrl,
  resolveAfterSignoutUrl,
  ownedSessionCookieDescriptor,
} = require('../src/services/sso/ssoSignout');

/** Synthetic 32-hex client ID standing in for the RAE V2 registration. */
const RAE_CLIENT_ID = 'a46a0b5374b4404a9f71a2397dcab283';
const SIGNOUT = 'https://sso.mju.ac.th/signout.aspx';
const APP_ORIGIN = 'https://raeservice.mju.ac.th';

// --- client ID ---------------------------------------------------------------------------------------

test('signout refuses the sample client ID', () => {
  assert.throws(
    () => assertNotSampleClientId(SAMPLE_CLIENT_ID),
    (err) => err.code === 'SSO_CLIENT_ID_IS_SAMPLE',
  );
  // The rejected value must not be echoed into a message that ends up in logs.
  try {
    assertNotSampleClientId(SAMPLE_CLIENT_ID);
  } catch (err) {
    assert.equal(err.message.includes(SAMPLE_CLIENT_ID), false);
  }
});

test('signout accepts the RAE V2 client ID and normalises case', () => {
  assert.equal(assertNotSampleClientId(RAE_CLIENT_ID), RAE_CLIENT_ID);
  assert.equal(assertNotSampleClientId(`  ${RAE_CLIENT_ID.toUpperCase()}  `), RAE_CLIENT_ID);
});

test('signout rejects a missing or malformed client ID', () => {
  for (const bad of ['', '   ', null, undefined, 'not-hex', 'a46a0b5374b4404a9f71a2397dcab28']) {
    assert.throws(() => assertNotSampleClientId(bad), (err) => /SSO_CLIENT_ID_/.test(err.code));
  }
});

// --- signout endpoint --------------------------------------------------------------------------------

test('signout endpoint must be https, absolute and credential-free', () => {
  assert.doesNotThrow(() => assertSignoutEndpoint(SIGNOUT));
  const rejected = [
    ['http://sso.mju.ac.th/signout.aspx', 'SSO_SIGNOUT_URL_NOT_HTTPS'],
    ['/signout.aspx', 'SSO_SIGNOUT_URL_INVALID'],
    ['https://user:pass@sso.mju.ac.th/signout.aspx', 'SSO_SIGNOUT_URL_HAS_CREDENTIALS'],
    ['https://sso.mju.ac.th/signout.aspx#frag', 'SSO_SIGNOUT_URL_HAS_FRAGMENT'],
    ['', 'SSO_SIGNOUT_URL_MISSING'],
    ['not a url', 'SSO_SIGNOUT_URL_INVALID'],
  ];
  for (const [value, code] of rejected) {
    assert.throws(() => assertSignoutEndpoint(value), (err) => err.code === code, `${value} should be ${code}`);
  }
});

// --- signout URL -------------------------------------------------------------------------------------

test('the built signout URL carries the RAE client ID exactly once', () => {
  const url = new URL(buildSignoutUrl({ signoutUrl: SIGNOUT, clientId: RAE_CLIENT_ID }));
  assert.equal(url.host, 'sso.mju.ac.th');
  assert.equal(url.pathname, '/signout.aspx');
  assert.equal(url.searchParams.getAll('cid').length, 1);
  assert.equal(url.searchParams.get('cid'), RAE_CLIENT_ID);
});

test('a stale cid already in the environment is replaced, not appended', () => {
  const url = new URL(buildSignoutUrl({
    signoutUrl: `${SIGNOUT}?cid=${SAMPLE_CLIENT_ID}`,
    clientId: RAE_CLIENT_ID,
  }));
  assert.deepEqual(url.searchParams.getAll('cid'), [RAE_CLIENT_ID]);
});

test('the signout URL cannot be built from the sample client ID', () => {
  assert.throws(
    () => buildSignoutUrl({ signoutUrl: SIGNOUT, clientId: SAMPLE_CLIENT_ID }),
    (err) => err.code === 'SSO_CLIENT_ID_IS_SAMPLE',
  );
});

// --- post-signout redirect safety (open redirect) ----------------------------------------------------

test('a same-origin after-signout URL is accepted', () => {
  const resolved = resolveAfterSignoutUrl({
    candidate: `${APP_ORIGIN}/attendance-v2/`,
    allowedOrigins: [APP_ORIGIN],
  });
  assert.equal(resolved, `${APP_ORIGIN}/attendance-v2/`);
});

test('a path-only after-signout URL resolves on the single allowed origin', () => {
  const resolved = resolveAfterSignoutUrl({ candidate: '/attendance-v2/', allowedOrigins: [APP_ORIGIN] });
  assert.equal(resolved, `${APP_ORIGIN}/attendance-v2/`);
});

test('open redirects are rejected', () => {
  const cases = [
    ['https://evil.example/steal', 'SSO_AFTER_SIGNOUT_OFFSITE'],
    ['//evil.example/steal', 'SSO_AFTER_SIGNOUT_OFFSITE'],
    ['/\\evil.example/steal', 'SSO_AFTER_SIGNOUT_INVALID'],
    ['javascript:alert(1)', 'SSO_AFTER_SIGNOUT_SCHEME'],
    ['data:text/html,<script>alert(1)</script>', 'SSO_AFTER_SIGNOUT_SCHEME'],
    ['https://user:pass@raeservice.mju.ac.th/', 'SSO_AFTER_SIGNOUT_HAS_CREDENTIALS'],
    ['https://raeservice.mju.ac.th.evil.example/', 'SSO_AFTER_SIGNOUT_OFFSITE'],
    ['https://raeservice.mju.ac.th\\@evil.example/', 'SSO_AFTER_SIGNOUT_INVALID'],
    ['/attendance-v2/\u0000', 'SSO_AFTER_SIGNOUT_INVALID'],
  ];
  for (const [candidate, code] of cases) {
    assert.throws(
      () => resolveAfterSignoutUrl({ candidate, allowedOrigins: [APP_ORIGIN] }),
      (err) => err.code === code,
      `expected ${code} for ${JSON.stringify(candidate)}`,
    );
  }
});

test('a look-alike suffix host is not accepted as the same origin', () => {
  // raeservice.mju.ac.th.evil.example and evil-raeservice.mju.ac.th must both fail: origin comparison is exact.
  for (const hostile of [
    'https://raeservice.mju.ac.th.evil.example/x',
    'https://evil-raeservice.mju.ac.th/x',
    'https://raeservice.mju.ac.th:8443/x',
    'http://raeservice.mju.ac.th/x',
  ]) {
    assert.throws(
      () => resolveAfterSignoutUrl({ candidate: hostile, allowedOrigins: [APP_ORIGIN] }),
      (err) => err.code === 'SSO_AFTER_SIGNOUT_OFFSITE',
      `${hostile} must not be treated as the app origin`,
    );
  }
});

test('a relative path with zero or several allowed origins is ambiguous, not silently guessed', () => {
  assert.throws(
    () => resolveAfterSignoutUrl({ candidate: '/x', allowedOrigins: [] }),
    (err) => err.code === 'SSO_AFTER_SIGNOUT_AMBIGUOUS',
  );
  assert.throws(
    () => resolveAfterSignoutUrl({ candidate: '/x', allowedOrigins: [APP_ORIGIN, 'https://other.example'] }),
    (err) => err.code === 'SSO_AFTER_SIGNOUT_AMBIGUOUS',
  );
});

test('a configured fallback is used when no candidate is supplied, and is itself validated', () => {
  const resolved = resolveAfterSignoutUrl({
    candidate: null,
    allowedOrigins: [APP_ORIGIN],
    fallback: `${APP_ORIGIN}/attendance-v2/`,
  });
  assert.equal(resolved, `${APP_ORIGIN}/attendance-v2/`);
  assert.throws(
    () => resolveAfterSignoutUrl({ candidate: '', allowedOrigins: [APP_ORIGIN], fallback: 'https://evil.example/' }),
    (err) => err.code === 'SSO_AFTER_SIGNOUT_OFFSITE',
  );
  assert.throws(
    () => resolveAfterSignoutUrl({ candidate: null, allowedOrigins: [APP_ORIGIN] }),
    (err) => err.code === 'SSO_AFTER_SIGNOUT_MISSING',
  );
});

// --- cookie ownership --------------------------------------------------------------------------------

test('RAE V2 refuses a parent-domain cookie (the sample used Domain=mju.ac.th)', () => {
  assert.throws(
    () => ownedSessionCookieDescriptor({ name: 'SES_PERSON_CITIZEN', domain: 'mju.ac.th' }),
    (err) => err.code === 'SSO_COOKIE_DOMAIN_NOT_ALLOWED',
  );
});

test('an owned session cookie descriptor is host-only and fully attributed', () => {
  const descriptor = ownedSessionCookieDescriptor({ name: 'rae_v2_session' });
  assert.deepEqual(descriptor, {
    name: 'rae_v2_session',
    path: '/',
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    expiresEpochMs: 0,
  });
  assert.ok(Object.isFrozen(descriptor));
  // A deletion must carry a Path; a path that differs from the original silently fails to remove the cookie.
  assert.equal(descriptor.path, '/');
  assert.throws(() => ownedSessionCookieDescriptor({ name: 'rae_v2_session', path: 'attendance' }),
    (err) => err.code === 'SSO_COOKIE_PATH_INVALID');
});

test('cookie names must be legal cookie tokens', () => {
  for (const bad of ['', 'has space', 'semi;colon', 'eq=uals', null]) {
    assert.throws(() => ownedSessionCookieDescriptor({ name: bad }), (err) => err.code === 'SSO_COOKIE_NAME_INVALID');
  }
});
