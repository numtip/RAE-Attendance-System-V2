/**
 * SSO MVP end to end over HTTP (real Express app, cookies, redirects) with a scripted provider and SYNTHETIC identities:
 * login -> MJU -> callback validation -> identity mapping -> attendance session -> logout.
 * Cases: valid login, spoofed/invalid callback, invalid token, wrong-user mapping, replay, logout, fail-closed defaults.
 * No network, no real identities, no real keys.
 */
require('./helpers/syntheticIdentifierKeys');
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const realConfig = require('../src/config');
const { createApp } = require('../src/app');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { HttpError } = require('../src/utils/httpError');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const MJU_UID = '11111111-1111-1111-1111-111111111111'; // MJU person: personnel_id + national (HMAC) + HIP id
const HIP_UID = '22222222-2222-2222-2222-222222222222'; // contractor: HIP id + national (HMAC), no personnel_id, no MJU
const MJU_NATIONAL = '9900000000011'; // synthetic
const HIP_NATIONAL = '9900000000012'; // synthetic
const STRANGER_NATIONAL = '9900000000099'; // synthetic, in nobody's record

function repositories() {
  return createFixtureRepositories({
    identifiers: [
      { employeeUid: MJU_UID, idType: 'personnel_id', idValue: 'PX-00001', sourceSystem: 'mju_person_api' },
      { employeeUid: MJU_UID, idType: 'national_id', idValue: MJU_NATIONAL, sourceSystem: 'IDCardRaecsv2027' },
      { employeeUid: HIP_UID, idType: 'facescan_id', idValue: 'HX0002', sourceSystem: 'IDCardRaecsv2027', isPrimary: true },
      { employeeUid: HIP_UID, idType: 'national_id', idValue: HIP_NATIONAL, sourceSystem: 'IDCardRaecsv2027' },
    ],
  });
}

/** Provider stand-in: only 'good-code' redeems; the access token it issues is the only one userinfo accepts. */
function provider({ profile, tokenResponse, exchangeError, userInfoError } = {}) {
  const calls = { exchange: 0, userinfo: 0 };
  return {
    calls,
    kind: 'scripted',
    buildAuthorizationUrl: ({ authorizationUrl, state }) => `${authorizationUrl}?state=${state}`,
    async exchangeCode({ code }) {
      calls.exchange += 1;
      if (exchangeError) throw exchangeError;
      if (code !== 'good-code') throw new HttpError(401, 'SSO_TOKEN_ERROR', 'Authorization code is invalid');
      return tokenResponse || { access_token: 'access-issued-by-provider', token_type: 'Bearer' };
    },
    async fetchUserInfo({ accessToken }) {
      calls.userinfo += 1;
      if (userInfoError) throw userInfoError;
      if (accessToken !== 'access-issued-by-provider') throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request');
      return profile;
    },
  };
}

async function start({ profile = { sub: 'subject-1', citizenID: MJU_NATIONAL }, env = 'test', sso = {}, repos = repositories(), ...providerOptions } = {}) {
  const oauthProvider = provider({ profile, ...providerOptions });
  const config = {
    ...realConfig,
    app: { ...realConfig.app, env, url: 'http://127.0.0.1:3100' },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      protocolContractConfirmed: true,
      subjectContractConfirmed: true,
      provider: 'http',
      scopes: 'profile',
      authorizationUrl: 'https://sso.example.test/authorize',
      tokenUrl: 'https://sso.example.test/token',
      userInfoUrl: 'https://sso.example.test/userinfo',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
      nationalIdClaims: 'citizenID',
      loginHandoffTtlMs: 45_000,
      ...sso,
    },
  };
  const server = http.createServer(createApp({ container: { config, dataSource: 'fixture', repositories: repos, oauthProvider } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const seen = []; // every response body, to prove nothing leaks the citizen ID
  const call = async (path, { cookie, method = 'GET', body, bearer } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    seen.push(text, response.headers.get('location') || '');
    return {
      status: response.status,
      location: response.headers.get('location'),
      setCookie: response.headers.getSetCookie(),
      json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    };
  };
  /** Browser step 1: /login. Returns the state and the cookie jar value the browser would hold. */
  const begin = async () => {
    const login = await call('/auth/sso/login');
    return {
      login,
      state: login.location ? new URL(login.location).searchParams.get('state') : null,
      cookie: login.setCookie.map((c) => c.split(';')[0]).join('; '),
    };
  };
  /** Browser steps 1-2: login then callback. */
  const signIn = async (code = 'good-code') => {
    const { state, cookie } = await begin();
    const callback = await call(`/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`, { cookie });
    return { state, cookie, callback };
  };
  const exchange = (callback) => call('/auth/sso/exchange', { method: 'POST', body: { code: new URL(callback.location).searchParams.get('code') } });
  return { call, begin, signIn, exchange, oauthProvider, repos, seen, close: () => server.close() };
}

// ------------------------------------------------------------------------------------------ happy path

test('valid login: MJU account -> verified callback -> subject linked to employee_uid -> session -> /me -> logout', async () => {
  const t = await start();
  try {
    const { login, cookie, callback } = await t.begin().then(async (b) => ({ ...b, callback: null }));
    assert.equal(login.status, 302);
    assert.match(login.setCookie[0], /HttpOnly/i);
    assert.match(login.setCookie[0], /SameSite=Lax/i);

    const done = await t.call(`/auth/sso/callback?code=good-code&state=${encodeURIComponent(new URL(login.location).searchParams.get('state'))}`, { cookie });
    assert.equal(callback, null);
    assert.equal(done.status, 302);
    const target = new URL(done.location);
    assert.equal(target.pathname, '/auth/sso/complete');
    assert.equal(done.location.includes('eyJ'), false, 'no JWT in the redirect URL');

    const session = (await t.exchange(done)).json.data;
    assert.ok(session.accessToken && session.refreshToken);
    assert.equal(jwt.decode(session.accessToken).sub, MJU_UID);

    const link = await t.repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-1');
    assert.equal(link.employeeUid, MJU_UID);
    assert.equal(link.status, 'approved');

    const me = await t.call('/auth/sso/me', { bearer: session.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.employeeUid, MJU_UID);

    // logout: refresh token is revoked and cannot be reused
    const out = await t.call('/auth/sso/logout', { method: 'POST', bearer: session.accessToken, body: { refreshToken: session.refreshToken } });
    assert.equal(out.status, 200);
    assert.equal(out.json.data.revoked, true);
    assert.ok((await t.repos.refreshTokens.find(session.refreshToken)).revokedAt, 'refresh token revoked');
    // logout is bound to the caller: another employee cannot revoke this session
    const other = jwt.sign({ role: 'employee' }, process.env.JWT_SECRET, { subject: HIP_UID, expiresIn: '15m' });
    assert.equal((await t.call('/auth/sso/logout', { method: 'POST', bearer: other, body: { refreshToken: session.refreshToken } })).status, 401);
    assert.equal((await t.call('/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } })).status, 401);

    // PII: the citizen ID never appears in any response body or redirect
    assert.equal(t.seen.some((text) => text.includes(MJU_NATIONAL)), false);
  } finally {
    t.close();
  }
});

test('contractor without MJU: attendance identity is HIP only; no SSO is required and no SSO account is ever created', async () => {
  const t = await start({ profile: { sub: 'unused', citizenID: STRANGER_NATIONAL } });
  try {
    const identity = createEmployeeIdentityService({ repositories: t.repos });
    const kind = await identity.getIdentityKind(HIP_UID);
    assert.equal(kind.kind, 'HIP');
    assert.deepEqual(kind.attendance, { eligible: true, via: 'facescan_id', requiresMjuSso: false });
    assert.equal(await identity.resolveUid('facescan_id', 'HX0002'), HIP_UID);
    assert.equal((await identity.listIdentifiers(HIP_UID)).some((row) => row.idType === 'personnel_id'), false, 'no fabricated personnel_id');
    assert.equal(await t.repos.identityLinks.findApprovedForEmployee(HIP_UID, 1), null, 'no SSO account/link without a verified MJU login');
  } finally {
    t.close();
  }
});

test('contractor who does have an MJU account may sign in: the verified subject links to the SAME employee_uid, still HIP', async () => {
  const t = await start({ profile: { sub: 'subject-hip', citizenID: HIP_NATIONAL } });
  try {
    const { callback } = await t.signIn();
    const session = (await t.exchange(callback)).json.data;
    assert.equal(jwt.decode(session.accessToken).sub, HIP_UID);
    assert.equal((await t.repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-hip')).employeeUid, HIP_UID);
    assert.equal((await createEmployeeIdentityService({ repositories: t.repos }).getIdentityKind(HIP_UID)).kind, 'HIP');
  } finally {
    t.close();
  }
});

// ------------------------------------------------------------------------ spoofed / invalid callback

test('spoofed callback (login CSRF): valid state without the browser cookie, with another browser\'s cookie, or forged is rejected before any provider call', async () => {
  const t = await start();
  try {
    const attacker = await t.begin();
    const victim = await t.begin();
    const url = (state) => `/auth/sso/callback?code=good-code&state=${encodeURIComponent(state)}`;
    assert.equal((await t.call(url(attacker.state))).status, 403, 'no cookie');
    assert.equal((await t.call(url(attacker.state), { cookie: victim.cookie })).status, 403, 'someone else\'s cookie');
    assert.equal((await t.call(url('forged-state'), { cookie: attacker.cookie })).status, 403, 'forged state');
    assert.equal((await t.call('/auth/sso/callback?code=good-code', { cookie: attacker.cookie })).status, 403, 'missing state');
    assert.equal((await t.call(`/auth/sso/callback?code[]=a&code[]=b&state=${attacker.state}`, { cookie: attacker.cookie })).status, 400, 'array parameter');
    assert.equal(t.oauthProvider.calls.exchange, 0);
    assert.equal((await t.call('/auth/sso/callback?error=access_denied', { cookie: attacker.cookie })).status, 401, 'provider-reported error');
    // a client-supplied binding cookie is never adopted
    const fixation = await t.call('/auth/sso/login', { cookie: 'rae_sso_bind=attacker-chosen-value-0000000000' });
    assert.doesNotMatch(fixation.setCookie[0], /attacker-chosen/);
  } finally {
    t.close();
  }
});

// -------------------------------------------------------------------------------------- invalid token

test('invalid token: bad code, missing/foreign access token, userinfo refusal and tampered session tokens create no session or link', async () => {
  for (const [label, options, expected] of [
    ['bad authorization code', {}, { code: 'bad-code', status: 401 }],
    ['no access_token', { tokenResponse: { token_type: 'Bearer' } }, { status: 502 }],
    ['non-bearer token type', { tokenResponse: { access_token: 'access-issued-by-provider', token_type: 'mac' } }, { status: 502 }],
    ['foreign access token refused by userinfo', { tokenResponse: { access_token: 'someone-elses-token', token_type: 'Bearer' } }, { status: 502 }],
    ['userinfo error', { userInfoError: new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request') }, { status: 502 }],
    ['userinfo is not an object', { profile: ['x'] }, { status: 502 }],
  ]) {
    const t = await start(options);
    try {
      const { callback } = await t.signIn(expected.code);
      assert.equal(callback.status, expected.status, label);
      assert.equal(await t.repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-1'), null, label);
    } finally {
      t.close();
    }
  }

  const t = await start();
  try {
    const { callback } = await t.signIn();
    const { accessToken } = (await t.exchange(callback)).json.data;
    const [h, p, s] = accessToken.split('.');
    const forged = jwt.sign({ role: 'admin' }, 'not-the-server-secret', { subject: MJU_UID, expiresIn: '15m' });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: HIP_UID })).toString('base64url')}.${s}`;
    for (const token of [forged, none, tampered, 'garbage']) {
      assert.equal((await t.call('/auth/sso/me', { bearer: token })).status, 401);
    }
    assert.equal((await t.call('/auth/sso/me', { bearer: accessToken })).status, 200);
  } finally {
    t.close();
  }
});

// -------------------------------------------------------------------------------- wrong-user mapping

test('wrong-user mapping: unknown or name/e-mail-only identities are denied; a subject cannot move to another employee', async () => {
  for (const [profile, code] of [
    [{ sub: 's-unknown', citizenID: STRANGER_NATIONAL }, 'SSO_USER_UNKNOWN'],
    [{ sub: 's-name-only', name: 'Synthetic Person', email: 'admin@example.test' }, 'SSO_NATIONAL_ID_MISSING'],
    [{ sub: 's-bad-id', citizenID: '12345' }, 'SSO_NATIONAL_ID_INVALID'],
  ]) {
    const t = await start({ profile });
    try {
      const before = (await createEmployeeIdentityService({ repositories: t.repos }).listIdentifiers(MJU_UID)).length;
      const { callback } = await t.signIn();
      assert.equal(callback.status, 403);
      assert.equal(JSON.parse(t.seen.at(-2)).error?.code ?? JSON.parse(t.seen.at(-2)).code, code);
      assert.equal(await t.repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, profile.sub), null);
      assert.equal((await createEmployeeIdentityService({ repositories: t.repos }).listIdentifiers(MJU_UID)).length, before, 'nothing created');
    } finally {
      t.close();
    }
  }

  // subject already bound to the MJU person cannot be used to sign in as the contractor
  const repos = repositories();
  const first = await start({ repos, profile: { sub: 'subject-shared', citizenID: MJU_NATIONAL } });
  try {
    assert.equal((await first.signIn()).callback.status, 302);
  } finally {
    first.close();
  }
  const second = await start({ repos, profile: { sub: 'subject-shared', citizenID: HIP_NATIONAL } });
  try {
    const { callback } = await second.signIn();
    assert.equal(callback.status, 409);
  } finally {
    second.close();
  }
});

// ------------------------------------------------------------------------------------------- replay

test('replay: a used state, a used handoff code and an expired handoff code are all refused', async () => {
  const t = await start();
  try {
    const { state, cookie, callback } = await t.signIn();
    assert.equal(callback.status, 302);
    const again = await t.call(`/auth/sso/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(again.status, 403, 'state replay');
    assert.equal(t.oauthProvider.calls.exchange, 1, 'the replay never reached the provider');

    assert.equal((await t.exchange(callback)).status, 200);
    assert.equal((await t.exchange(callback)).status, 401, 'handoff code is single use');
    assert.equal((await t.call('/auth/sso/exchange', { method: 'POST', body: { code: 'a'.repeat(48) } })).status, 401, 'guessed code');
  } finally {
    t.close();
  }

  const expired = await start({ sso: { loginHandoffTtlMs: 1 } });
  try {
    const { callback } = await expired.signIn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await expired.exchange(callback)).status, 401, 'expired handoff code');
  } finally {
    expired.close();
  }
});

// ----------------------------------------------------------------------------- fail-closed defaults

test('fail closed: SSO off, or on without MJU\'s confirmed protocol / citizen-ID claim, never redirects or issues a session', async () => {
  for (const [label, sso, status] of [
    ['disabled', { enabled: false }, 403],
    ['callback not registered', { callbackConfirmed: false }, 503],
    ['protocol unconfirmed', { protocolContractConfirmed: false }, 503],
  ]) {
    const t = await start({ sso });
    try {
      const login = await t.call('/auth/sso/login');
      assert.equal(login.status, status, label);
      assert.equal(login.location, null, label);
    } finally {
      t.close();
    }
  }
  const t = await start({ sso: { nationalIdClaims: '' } });
  try {
    const { callback } = await t.signIn();
    assert.equal(callback.status, 503, 'claim name unconfirmed');
    assert.equal(await t.repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-1'), null);
  } finally {
    t.close();
  }
  assert.equal(realConfig.sso.enabled, false, 'shipped default is OFF');
  assert.equal(realConfig.sso.protocolContractConfirmed, false);
});

test('production: session cookie is Secure and the mock provider / non-https endpoints are refused', async () => {
  const https = { authorizationUrl: 'https://sso.example.test/authorize', tokenUrl: 'https://sso.example.test/token', userInfoUrl: 'https://sso.example.test/userinfo', callbackUrl: 'https://app.example.test/api/v1/auth/sso/callback' };
  const ok = await start({ env: 'production', sso: https });
  try {
    const login = await ok.call('/auth/sso/login');
    assert.equal(login.status, 302);
    assert.match(login.setCookie[0], /; Secure/i);
  } finally {
    ok.close();
  }
  for (const sso of [{ ...https, provider: 'mock' }, { ...https, tokenUrl: 'http://sso.example.test/token' }]) {
    const bad = await start({ env: 'production', sso });
    try {
      assert.equal((await bad.call('/auth/sso/login')).status, 503);
    } finally {
      bad.close();
    }
  }
});

test('production detection reads the real config shape (config.app.env)', () => {
  const { isProduction } = require('../src/services/sso/ssoConfig');
  assert.equal(isProduction({ ...realConfig, app: { ...realConfig.app, env: 'production' } }), true);
  assert.equal(isProduction({ ...realConfig, app: { ...realConfig.app, env: 'development' } }), false);
  assert.equal(isProduction(realConfig), process.env.NODE_ENV === 'production');
});
