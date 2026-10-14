/**
 * MJU portal flow from the vendor sample, end to end over HTTP with a mock token.aspx and SYNTHETIC identities:
 *   login -> signin.aspx?cid= -> callback ?ac= -> POST token.aspx {clientID, code} -> validate -> map -> session.
 * Covers: success, code refused, incomplete/odd responses, wrong-user mapping, replay, browser binding and gates.
 * No network beyond 127.0.0.1, no real identities, no real keys, no secrets.
 */
require('./helpers/syntheticIdentifierKeys');
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../src/utils/httpError');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const realConfig = require('../src/config');
const { createApp } = require('../src/app');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');
const { createMjuPortalGuard } = require('../src/services/sso/mjuPortalGuard');
const { normalizeMjuIdentityResponse } = require('../src/services/sso/mjuTokenClient');

const MJU_UID = '11111111-1111-1111-1111-111111111111';
const HIP_UID = '22222222-2222-2222-2222-222222222222';
const MJU_NATIONAL = '9900000000011'; // synthetic
const HIP_NATIONAL = '9900000000012'; // synthetic
const STRANGER_NATIONAL = '9900000000099'; // synthetic, in nobody's record
const GOOD_AC = '0123456789abcdef0123456789abcdef'; // synthetic 32-char value (shape recorded by MJU; meaning unknown)
const SYNTHETIC_NAME = 'Synthetic Person';
const SYNTHETIC_EMAIL = 'synthetic.person@example.test';

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

/** token.aspx stand-in. `reply(body, req)` returns { status, body } or { hang: true }; every request is recorded. */
async function startMjuMock(reply) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* recorded as null */ }
      const record = { method: req.method, url: req.url, headers: req.headers, raw, json };
      requests.push(record);
      const out = reply(json, record);
      if (out.hang) return; // never answers
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/token.aspx`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

/** A well-formed token.aspx document (vendor-sample property names) for a synthetic MJU person. */
function identityDoc(overrides = {}) {
  return {
    citizenID: MJU_NATIONAL,
    humanID: 'H-100234',
    personID: '100234',
    name: SYNTHETIC_NAME,
    e_mail: SYNTHETIC_EMAIL,
    firstName: 'Synthetic',
    lastName: 'Person',
    ...overrides,
  };
}

async function start({ reply = (body) => ({ body: body.code === GOOD_AC ? identityDoc() : {} }), sso = {}, repos = repositories(), env = 'test', portalGuard, codeReplayStore = null } = {}) {
  const mju = await startMjuMock(reply);
  const config = {
    ...realConfig,
    app: { ...realConfig.app, env, url: 'http://127.0.0.1:3100' },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      // Vendor-sample evidence only. These flags mean "MJU IT certified" and must stay false on this path.
      protocolContractConfirmed: false,
      subjectContractConfirmed: false,
      mjuTokenFlow: true,
      subjectClaim: 'humanID',
      provider: 'http',
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      tokenUrl: mju.url,
      clientId: 'synthetic-client',
      clientSecret: '',
      callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
      nationalIdClaims: '', // the token.aspx path must not depend on it
      loginHandoffTtlMs: 45_000,
      httpTimeoutMs: 2_000,
      ...sso,
    },
  };
  const server = http.createServer(createApp({
    container: { config, dataSource: 'fixture', repositories: repos, portalGuard, codeReplayStore },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const seen = [];
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
  const begin = async () => {
    const login = await call('/auth/sso/login');
    return { login, cookie: login.setCookie.map((c) => c.split(';')[0]).join('; ') };
  };
  /** Browser: /login, then MJU sends it back with ?ac=. */
  const signIn = async (ac = GOOD_AC) => {
    const { login, cookie } = await begin();
    const callback = await call(`/auth/sso/callback?ac=${encodeURIComponent(ac)}`, { cookie });
    return { login, cookie, callback };
  };
  const exchange = (callback, extra = {}) => call('/auth/sso/exchange', {
    method: 'POST',
    body: { code: new URL(callback.location).searchParams.get('code'), confirm: true, ...extra },
  });
  const linkFor = (subject) => repos.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, subject);
  return { call, begin, signIn, exchange, linkFor, mju, repos, seen, close: () => { server.close(); mju.close(); } };
}

const errorCode = (response) => response.json?.error?.code;

function assertNoLeak(t) {
  for (const text of t.seen) {
    assert.equal(text.includes(MJU_NATIONAL), false, 'citizen ID leaked');
    assert.equal(text.includes(HIP_NATIONAL), false, 'citizen ID leaked');
    assert.equal(text.includes(SYNTHETIC_NAME), false, 'name leaked');
    assert.equal(text.includes(SYNTHETIC_EMAIL), false, 'email leaked');
  }
}

// ------------------------------------------------------------------------------------------ happy path

test('valid login: signin?cid= -> ?ac= -> POST token.aspx {clientID, code} -> mapped by HMAC citizen ID -> session -> /me -> logout', async () => {
  const t = await start();
  try {
    const { login, callback } = await t.signIn();

    // step 1: the browser is sent to MJU with the client id only (no OAuth parameters) and gets an HttpOnly binding cookie
    assert.equal(login.status, 302);
    const signin = new URL(login.location);
    assert.equal(`${signin.origin}${signin.pathname}`, 'https://sso.mju.ac.th/signin.aspx');
    assert.deepEqual([...signin.searchParams.keys()], ['cid']);
    assert.equal(signin.searchParams.get('cid'), 'synthetic-client');
    assert.match(login.setCookie[0], /HttpOnly/i);
    assert.match(login.setCookie[0], /SameSite=Lax/i);
    assert.match(login.setCookie[0], /Path=\/api\/v1\/auth\/sso/);
    assert.doesNotMatch(login.setCookie[0], /;\s*Secure/i);
    assert.doesNotMatch(login.setCookie[0], /Domain=/i);

    // step 2: exactly one POST to token.aspx, JSON {clientID, code}, no secret, no OAuth fields, no auth header
    assert.equal(t.mju.requests.length, 1);
    const [req] = t.mju.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/token.aspx');
    assert.match(req.headers['content-type'], /^application\/json/);
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(req.json, { clientID: 'synthetic-client', code: GOOD_AC });
    assert.deepEqual(Object.keys(req.json).sort(), ['clientID', 'code']);

    // step 3: session handoff, no JWT in the URL
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.location).pathname, '/auth/sso/complete');
    assert.equal(callback.location.includes('eyJ'), false);
    const session = (await t.exchange(callback)).json.data;
    assert.equal(jwt.decode(session.accessToken).sub, MJU_UID);

    // the stored subject is humanID: not `ac`, not the citizen ID
    const link = await t.linkFor('H-100234');
    assert.equal(link.employeeUid, MJU_UID);
    assert.equal(link.status, 'approved');
    assert.equal(link.source, 'mju_token_candidate_subject');
    assert.equal(link.subjectType, 'candidate:humanID');
    assert.equal(link.confidence, 'medium');
    assert.equal(link.emailSnapshot ?? null, null);
    assert.equal(await t.linkFor(GOOD_AC), null);
    assert.equal(await t.linkFor(MJU_NATIONAL), null);
    assert.equal(JSON.stringify(link).includes(MJU_NATIONAL), false, 'no raw citizen ID stored on the link');
    assert.equal(await t.linkFor('100234'), null, 'personID is not the subject unless configured');

    const me = await t.call('/auth/sso/me', { bearer: session.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.employeeUid, MJU_UID);
    const out = await t.call('/auth/sso/logout', { method: 'POST', bearer: session.accessToken, body: { refreshToken: session.refreshToken } });
    assert.equal(out.status, 200);
    assert.equal(new URL(out.json.data.signoutUrl).searchParams.get('cid'), 'synthetic-client');
    assert.ok((await t.repos.refreshTokens.find(session.refreshToken)).revokedAt);

    assertNoLeak(t);
  } finally {
    t.close();
  }
});

test('second login of the same linked person uses the stored subject and the citizen ID agrees', async () => {
  const t = await start();
  try {
    const first = await t.signIn(GOOD_AC);
    assert.equal(first.callback.status, 302);
    assert.equal((await t.exchange(first.callback)).status, 200);
    const next = 'fedcba9876543210fedcba9876543210';
    t.mju.requests.length = 0;
    const t2 = await start({ repos: t.repos, reply: (body) => ({ body: body.code === next ? identityDoc() : {} }) });
    try {
      const { callback } = await t2.signIn(next);
      assert.equal(callback.status, 302);
      assert.equal(jwt.decode((await t2.exchange(callback)).json.data.accessToken).sub, MJU_UID);
    } finally {
      t2.close();
    }
  } finally {
    t.close();
  }
});

test('personID is accepted as the subject only when the operator selects it; citizenID never can be', async () => {
  const personFlow = await start({ sso: { subjectClaim: 'personID' } });
  try {
    const started = await personFlow.signIn();
    assert.equal(started.callback.status, 302);
    assert.equal((await personFlow.exchange(started.callback)).status, 200);
    assert.equal((await personFlow.linkFor('100234')).employeeUid, MJU_UID);
    assert.equal(await personFlow.linkFor('H-100234'), null);
  } finally {
    personFlow.close();
  }

  const citizenFlow = await start({ sso: { subjectClaim: 'citizenID' } });
  try {
    const { callback } = await citizenFlow.signIn();
    assert.equal(callback.status, 503);
    assert.equal(errorCode(callback), 'SSO_NOT_READY');
    assert.equal(await citizenFlow.linkFor(MJU_NATIONAL), null);
  } finally {
    citizenFlow.close();
  }
});

// ------------------------------------------------------------------------------ code refused by MJU

test('code cannot be used: MJU refusing the code, or returning no identity, issues no session and creates no link', async () => {
  for (const [label, reply, status, code] of [
    ['HTTP 400', () => ({ status: 400, body: { error: 'bad code' } }), 401, 'SSO_CODE_INVALID'],
    ['HTTP 401', () => ({ status: 401, body: {} }), 401, 'SSO_CODE_INVALID'],
    ['HTTP 403', () => ({ status: 403, body: {} }), 401, 'SSO_CODE_INVALID'],
    ['HTTP 200 with an empty document', () => ({ body: {} }), 401, 'SSO_CODE_INVALID'],
    ['HTTP 200 with only names and e-mail', () => ({ body: { name: SYNTHETIC_NAME, e_mail: SYNTHETIC_EMAIL, firstName: 'Synthetic' } }), 401, 'SSO_CODE_INVALID'],
    ['HTTP 500', () => ({ status: 500, body: {} }), 502, 'SSO_PROVIDER_ERROR'],
    ['not JSON', () => ({ body: '<html>login</html>' }), 502, 'SSO_RESPONSE_INVALID'],
    ['JSON array', () => ({ body: [identityDoc()] }), 502, 'SSO_RESPONSE_INVALID'],
    ['JSON null', () => ({ body: 'null' }), 502, 'SSO_RESPONSE_INVALID'],
  ]) {
    const t = await start({ reply });
    try {
      const { callback } = await t.signIn();
      assert.equal(callback.status, status, label);
      assert.equal(errorCode(callback), code, label);
      assert.equal(callback.location, null, `${label}: no redirect to the app`);
      assert.equal(await t.linkFor('H-100234'), null, label);
      assert.equal(t.mju.requests.length, 1, label);
      assertNoLeak(t);
    } finally {
      t.close();
    }
  }
});

test('MJU unreachable or too slow fails closed', async () => {
  const slow = await start({ reply: () => ({ hang: true }), sso: { httpTimeoutMs: 80 } });
  try {
    const { callback } = await slow.signIn();
    assert.equal(callback.status, 504);
    assert.equal(errorCode(callback), 'SSO_PROVIDER_TIMEOUT');
  } finally {
    slow.close();
  }
  const down = await start({ sso: { tokenUrl: 'http://127.0.0.1:1/token.aspx' } });
  try {
    const { callback } = await down.signIn();
    assert.equal(callback.status, 502);
    assert.equal(errorCode(callback), 'SSO_PROVIDER_ERROR');
  } finally {
    down.close();
  }
});

// ------------------------------------------------------------------------------- response incomplete

test('incomplete response: a missing humanID or citizenID never opens a session, even when the other field matches someone', async () => {
  for (const [label, doc, code] of [
    ['citizenID only', { citizenID: MJU_NATIONAL, name: SYNTHETIC_NAME }, 'SSO_RESPONSE_INCOMPLETE'],
    ['humanID only', { humanID: 'H-100234', personID: '100234' }, 'SSO_RESPONSE_INCOMPLETE'],
    ['blank humanID', identityDoc({ humanID: '   ' }), 'SSO_RESPONSE_INCOMPLETE'],
    ['null citizenID', identityDoc({ citizenID: null }), 'SSO_RESPONSE_INCOMPLETE'],
    ['personID without humanID', { citizenID: MJU_NATIONAL, personID: '100234' }, 'SSO_RESPONSE_INCOMPLETE'],
    ['malformed citizenID', identityDoc({ citizenID: '12345' }), 'SSO_NATIONAL_ID_INVALID'],
  ]) {
    const t = await start({ reply: () => ({ body: doc }) });
    try {
      const { callback } = await t.signIn();
      assert.ok([502, 403].includes(callback.status), label);
      assert.equal(errorCode(callback), code, label);
      assert.equal(await t.linkFor('H-100234'), null, label);
      assertNoLeak(t);
    } finally {
      t.close();
    }
  }

  // a linked subject plus a malformed citizen ID must not fall back to subject-only login
  const repos = repositories();
  const first = await start({ repos });
  try {
    assert.equal((await first.signIn()).callback.status, 302);
  } finally {
    first.close();
  }
  const second = await start({ repos, reply: () => ({ body: identityDoc({ citizenID: '12345' }) }) });
  try {
    const { callback } = await second.signIn('fedcba9876543210fedcba9876543210');
    assert.equal(callback.status, 403);
    assert.equal(errorCode(callback), 'SSO_NATIONAL_ID_INVALID');
  } finally {
    second.close();
  }
});

test('unusable subject: ac, the citizen ID, or an e-mail can never be the subject', async () => {
  for (const [label, doc] of [
    ['humanID equals ac', identityDoc({ humanID: GOOD_AC })],
    ['humanID equals citizenID', identityDoc({ humanID: MJU_NATIONAL })],
    ['humanID contains the citizenID digits', identityDoc({ humanID: `H${MJU_NATIONAL}` })],
    ['humanID is an e-mail', identityDoc({ humanID: SYNTHETIC_EMAIL })],
    ['humanID equals the name', identityDoc({ humanID: 'Synthetic', firstName: 'Synthetic' })],
    ['humanID has spaces', identityDoc({ humanID: 'H 1' })],
    ['humanID is too long', identityDoc({ humanID: 'H'.repeat(200) })],
  ]) {
    const t = await start({ reply: () => ({ body: doc }) });
    try {
      const { callback } = await t.signIn();
      assert.equal(callback.status, 403, label);
      assert.equal(errorCode(callback), 'SSO_SUBJECT_INVALID', label);
      assert.equal(await t.linkFor(GOOD_AC), null, label);
      assert.equal(await t.linkFor(MJU_NATIONAL), null, label);
      assertNoLeak(t);
    } finally {
      t.close();
    }
  }
});

// -------------------------------------------------------------------------------- wrong-user mapping

test('wrong-user mapping: unknown citizen ID, name/e-mail/personID coincidences and cross-linked subjects are denied', async () => {
  // unknown citizen ID, even with a name, e-mail and personID that look right
  const unknown = await start({ reply: () => ({ body: identityDoc({ citizenID: STRANGER_NATIONAL }) }) });
  try {
    const { callback } = await unknown.signIn();
    assert.equal(callback.status, 403);
    assert.equal(errorCode(callback), 'SSO_USER_UNKNOWN');
    assert.equal(await unknown.linkFor('H-100234'), null);
  } finally {
    unknown.close();
  }

  // an e-mail that belongs to an existing employee does not select that employee
  const emails = ['user@example.test', 'admin@example.test'];
  for (const email of emails) {
    const byEmail = await start({ reply: () => ({ body: identityDoc({ citizenID: STRANGER_NATIONAL, e_mail: email }) }) });
    try {
      const { callback } = await byEmail.signIn();
      assert.equal(callback.status, 403, email);
      assert.equal(errorCode(callback), 'SSO_USER_UNKNOWN', email);
    } finally {
      byEmail.close();
    }
  }

  // a subject already bound to the MJU person cannot sign in as the contractor
  const repos = repositories();
  const first = await start({ repos });
  try {
    const started = await first.signIn();
    assert.equal(started.callback.status, 302);
    assert.equal((await first.exchange(started.callback)).status, 200);
  } finally {
    first.close();
  }
  const second = await start({ repos, reply: () => ({ body: identityDoc({ citizenID: HIP_NATIONAL }) }) });
  try {
    const { callback } = await second.signIn('fedcba9876543210fedcba9876543210');
    assert.equal(callback.status, 409);
    assert.equal(errorCode(callback), 'IDENTITY_SUBJECT_CONFLICT');
    assert.equal((await second.linkFor('H-100234')).employeeUid, MJU_UID, 'link unchanged');
  } finally {
    second.close();
  }
});

test('HIP-only person with a citizen ID may sign in through MJU and stays the same employee_uid; no extra account is created', async () => {
  const t = await start({ reply: () => ({ body: identityDoc({ citizenID: HIP_NATIONAL, humanID: 'H-200001' }) }) });
  try {
    const { callback } = await t.signIn();
    assert.equal(callback.status, 302);
    assert.equal(jwt.decode((await t.exchange(callback)).json.data.accessToken).sub, HIP_UID);
    assert.equal((await t.linkFor('H-200001')).employeeUid, HIP_UID);
  } finally {
    t.close();
  }
});

// ------------------------------------------------------------------------------------------- replay

test('replay: the same ac, the same callback URL and the same handoff code cannot be used twice', async () => {
  const t = await start();
  try {
    const first = await t.signIn();
    assert.equal(first.callback.status, 302);
    assert.equal(t.mju.requests.length, 1);

    // same browser, same URL again: the binding is already burned
    const again = await t.call(`/auth/sso/callback?ac=${GOOD_AC}`, { cookie: first.cookie });
    assert.equal(again.status, 403);
    assert.equal(errorCode(again), 'SSO_STATE_INVALID');

    // a fresh login in a new browser that carries the already-used ac
    const replay = await t.signIn(GOOD_AC);
    assert.equal(replay.callback.status, 403);
    assert.equal(errorCode(replay.callback), 'SSO_CODE_REPLAY');
    assert.equal(t.mju.requests.length, 1, 'replays never reach MJU');

    assert.equal((await t.exchange(first.callback)).status, 200);
    assert.equal((await t.exchange(first.callback)).status, 401, 'handoff code is single use');
  } finally {
    t.close();
  }
});

test('a code MJU refused is not retried: the attempt is burned', async () => {
  const t = await start({ reply: () => ({ status: 400, body: {} }) });
  try {
    assert.equal(errorCode((await t.signIn('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).callback), 'SSO_CODE_INVALID');
    assert.equal(errorCode((await t.signIn('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).callback), 'SSO_CODE_REPLAY');
    assert.equal(t.mju.requests.length, 1);
  } finally {
    t.close();
  }
});

// ------------------------------------------------------------------------------ browser callback binding

test('browser binding: a callback without this browser\'s login cookie is refused before MJU is contacted', async () => {
  const t = await start();
  try {
    const attacker = await t.begin();
    const victim = await t.begin();
    assert.equal((await t.call(`/auth/sso/callback?ac=${GOOD_AC}`)).status, 403, 'no cookie');
    assert.equal(errorCode(await t.call(`/auth/sso/callback?ac=${GOOD_AC}`, { cookie: 'rae_sso_bind=forged-value-0123456789abcdef' })), 'SSO_STATE_INVALID', 'forged cookie');
    // Residual (MJU does not echo state): any unused ac is accepted with a live binding, including one
    // that was not issued for this login. The cookie is still single-use.
    assert.equal((await t.call(`/auth/sso/callback?ac=${GOOD_AC}`, { cookie: attacker.cookie })).status, 302, 'live binding accepts an ac that was not tied to it');
    assert.equal((await t.call(`/auth/sso/callback?ac=fedcba9876543210fedcba9876543210`, { cookie: attacker.cookie })).status, 403, 'and only once');
    assert.equal(t.mju.requests.length, 1);
    assert.ok(victim.cookie);

    // a client-supplied binding cookie is never adopted
    const fixation = await t.call('/auth/sso/login', { cookie: 'rae_sso_bind=attacker-chosen-value-0000000000' });
    assert.doesNotMatch(fixation.setCookie[0], /attacker-chosen/);
    assert.equal((await t.call(`/auth/sso/callback?ac=cccccccccccccccccccccccccccccccc`, { cookie: 'rae_sso_bind=attacker-chosen-value-0000000000' })).status, 403);
  } finally {
    t.close();
  }
});

test('csrf: swapped ac still reaches confirm; confirmation does not prove the ac belongs to this login', async () => {
  const repos = repositories();
  let saves = 0;
  const save = repos.refreshTokens.save.bind(repos.refreshTokens);
  repos.refreshTokens.save = async (record) => {
    saves += 1;
    return save(record);
  };
  const attackerAc = 'fedcba9876543210fedcba9876543210';
  const t = await start({
    repos,
    reply: (body) => ({ body: body.code === attackerAc ? identityDoc() : {} }),
  });
  try {
    const { cookie } = await t.begin();
    const callback = await t.call(`/auth/sso/callback?ac=${attackerAc}`, { cookie });
    assert.equal(callback.status, 302);
    assert.equal(t.mju.requests.length, 1);
    const code = new URL(callback.location).searchParams.get('code');
    const preview = await t.call('/auth/sso/exchange', { method: 'POST', body: { code } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.data.confirmationRequired, true);
    assert.equal(preview.json.data.subject, 'H-100234');
    assert.equal(preview.json.data.accessToken, undefined);
    assert.equal(saves, 0);
    assert.equal(await t.linkFor('H-100234'), null);
    const session = await t.call('/auth/sso/exchange', { method: 'POST', body: { code, confirm: true } });
    assert.equal(session.status, 200);
    assert.equal(saves, 1);
    assertNoLeak(t);
  } finally {
    t.close();
  }
});

test('csrf: abandoned confirmation writes no refresh token and no identity link', async () => {
  const repos = repositories();
  let saves = 0;
  const save = repos.refreshTokens.save.bind(repos.refreshTokens);
  repos.refreshTokens.save = async (record) => {
    saves += 1;
    return save(record);
  };
  const t = await start({ repos });
  try {
    const { callback } = await t.signIn();
    assert.equal(callback.status, 302);
    assert.equal(saves, 0);
    const code = new URL(callback.location).searchParams.get('code');
    const preview = await t.call('/auth/sso/exchange', { method: 'POST', body: { code } });
    assert.equal(preview.json.data.confirmationRequired, true);
    assert.equal(preview.json.data.accessToken, undefined);
    assert.equal(saves, 0);
    assert.equal(await t.linkFor('H-100234'), null);
    assertNoLeak(t);
  } finally {
    t.close();
  }
});

test('csrf: confirm false does not issue a session', async () => {
  const repos = repositories();
  let saves = 0;
  const save = repos.refreshTokens.save.bind(repos.refreshTokens);
  repos.refreshTokens.save = async (record) => {
    saves += 1;
    return save(record);
  };
  const t = await start({ repos });
  try {
    const { callback } = await t.signIn();
    const code = new URL(callback.location).searchParams.get('code');
    const preview = await t.call('/auth/sso/exchange', { method: 'POST', body: { code, confirm: false } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.data.confirmationRequired, true);
    assert.equal(preview.json.data.accessToken, undefined);
    assert.equal(saves, 0);
    assert.equal(await t.linkFor('H-100234'), null);
  } finally {
    t.close();
  }
});

test('csrf: concurrent confirm is single-use', async () => {
  const t = await start();
  try {
    const { callback } = await t.signIn();
    const code = new URL(callback.location).searchParams.get('code');
    const [left, right] = await Promise.all([
      t.call('/auth/sso/exchange', { method: 'POST', body: { code, confirm: true } }),
      t.call('/auth/sso/exchange', { method: 'POST', body: { code, confirm: true } }),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 401]);
    const winner = left.status === 200 ? left : right;
    assert.ok(winner.json.data.refreshToken);
    assert.equal((await t.linkFor('H-100234')).employeeUid, MJU_UID);
  } finally {
    t.close();
  }
});

test('csrf: expired binding is refused before MJU', async () => {
  let clock = 1_000;
  const portalGuard = createMjuPortalGuard({ bindingTtlMs: 50, now: () => clock });
  const t = await start({ portalGuard });
  try {
    const { cookie } = await t.begin();
    clock += 51;
    const callback = await t.call(`/auth/sso/callback?ac=${GOOD_AC}`, { cookie });
    assert.equal(callback.status, 403);
    assert.equal(errorCode(callback), 'SSO_STATE_INVALID');
    assert.equal(t.mju.requests.length, 0);
  } finally {
    t.close();
  }
});

test('csrf: expired handoff confirm writes no refresh token', async () => {
  const repos = repositories();
  let saves = 0;
  const save = repos.refreshTokens.save.bind(repos.refreshTokens);
  repos.refreshTokens.save = async (record) => {
    saves += 1;
    return save(record);
  };
  const t = await start({ repos, sso: { loginHandoffTtlMs: 30 } });
  try {
    const { callback } = await t.signIn();
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    const response = await t.exchange(callback);
    assert.equal(response.status, 401);
    assert.equal(errorCode(response), 'SSO_HANDOFF_EXPIRED');
    assert.equal(saves, 0);
  } finally {
    t.close();
  }
});

test('replay store: a failed durable claim does not call MJU or the in-memory map', async () => {
  let memoryClaims = 0;
  const portalGuard = createMjuPortalGuard();
  const original = portalGuard.claimCode.bind(portalGuard);
  portalGuard.claimCode = (code) => {
    memoryClaims += 1;
    return original(code);
  };
  const t = await start({
    portalGuard,
    codeReplayStore: {
      async claim() {
        throw new HttpError(503, 'SSO_REPLAY_STORE_UNAVAILABLE', 'down');
      },
    },
  });
  try {
    const { callback } = await t.signIn();
    assert.equal(callback.status, 503);
    assert.equal(errorCode(callback), 'SSO_REPLAY_STORE_UNAVAILABLE');
    assert.equal(t.mju.requests.length, 0);
    assert.equal(memoryClaims, 0);
  } finally {
    t.close();
  }
});

test('callback input validation: missing, repeated or malformed ac and provider errors never reach MJU', async () => {
  const t = await start();
  try {
    for (const [label, query, status] of [
      ['missing ac', '', 400],
      ['empty ac', '?ac=', 400],
      ['repeated ac', '?ac=aaaaaaaa&ac=bbbbbbbb', 400],
      ['ac with a space', '?ac=aaaa%20bbbb', 400],
      ['ac too long', `?ac=${'a'.repeat(300)}`, 400],
      ['provider error', '?error=access_denied', 401],
    ]) {
      const { cookie } = await t.begin();
      const response = await t.call(`/auth/sso/callback${query}`, { cookie });
      assert.equal(response.status, status, label);
    }
    assert.equal(t.mju.requests.length, 0);
  } finally {
    t.close();
  }
});

test('guard: bindings expire and codes are tracked as digests', () => {
  let clock = 1_000;
  const guard = createMjuPortalGuard({ bindingTtlMs: 100, codeTtlMs: 500, now: () => clock });
  guard.registerBinding('binding-aaaaaaaaaaaaaaaa');
  guard.registerBinding('binding-bbbbbbbbbbbbbbbb');
  assert.equal(guard.consumeBinding('binding-aaaaaaaaaaaaaaaa'), true);
  assert.equal(guard.consumeBinding('binding-aaaaaaaaaaaaaaaa'), false, 'single use');
  clock += 101;
  assert.equal(guard.consumeBinding('binding-bbbbbbbbbbbbbbbb'), false, 'expired');
  assert.equal(guard.consumeBinding(undefined), false);
  assert.equal(guard.consumeBinding(''), false);
  assert.equal(guard.claimCode('code-1'), true);
  assert.equal(guard.claimCode('code-1'), false);
  clock += 501;
  assert.equal(guard.claimCode('code-1'), true, 'forgotten after the TTL (in-memory only; MJU single-use is still unknown)');
});

test('guard: the oldest code digest is dropped after the in-memory cap', () => {
  const guard = createMjuPortalGuard();
  assert.equal(guard.claimCode('first-code'), true);
  for (let i = 0; i < 10001; i += 1) guard.claimCode(`code-${i}`);
  assert.equal(guard.claimCode('first-code'), true, 'evicted; not a durable cross-process store');
});

// ----------------------------------------------------------------------------------------- fail closed

test('gates: token flow off or SSO disabled refuses; contract flags do not certify or block the candidate subject', async () => {
  const off = await start({ sso: { mjuTokenFlow: false } });
  try {
    const { login, callback } = await off.signIn();
    assert.equal(login.status, 302, 'portal redirect stays as before');
    assert.equal(callback.status, 503, 'legacy portal behaviour: callback contract unconfirmed');
    assert.equal(off.mju.requests.length, 0);
  } finally {
    off.close();
  }

  // Written-confirmation flags stay false. The token flow still runs; the subject stays a candidate.
  const noProtocol = await start({ sso: { protocolContractConfirmed: false, subjectContractConfirmed: true } });
  try {
    const { callback } = await noProtocol.signIn();
    assert.equal(callback.status, 302);
    assert.equal((await noProtocol.exchange(callback)).status, 200);
    const link = await noProtocol.linkFor('H-100234');
    assert.equal(link.subjectType, 'candidate:humanID');
    assert.equal(link.source, 'mju_token_candidate_subject');
    assert.equal(link.confidence, 'medium');
  } finally {
    noProtocol.close();
  }

  const disabled = await start({ sso: { enabled: false } });
  try {
    assert.equal((await disabled.call('/auth/sso/login')).status, 403);
    assert.equal((await disabled.call(`/auth/sso/callback?ac=${GOOD_AC}`)).status, 403);
    assert.equal(disabled.mju.requests.length, 0);
  } finally {
    disabled.close();
  }

  const noToken = await start({ sso: { tokenUrl: '' } });
  try {
    assert.equal((await noToken.call('/auth/sso/login')).status, 503);
  } finally {
    noToken.close();
  }

  // Missing configured claim does not fall back to personID, name, or e-mail (covered above).
  // A disagreeing multi-value subject is ambiguous and creates no link.
  const ambiguous = await start({
    reply: () => ({ body: identityDoc({ humanID: ['H-100234', 'H-999999'] }) }),
  });
  try {
    const { callback } = await ambiguous.signIn();
    assert.equal(callback.status, 403);
    assert.equal(errorCode(callback), 'SSO_SUBJECT_AMBIGUOUS');
    assert.equal(await ambiguous.linkFor('H-100234'), null);
    assert.equal(await ambiguous.linkFor('H-999999'), null);
  } finally {
    ambiguous.close();
  }
});

test('production: token.aspx must be https, and a https login cookie is Secure', async () => {
  const insecure = await start({ env: 'production', sso: { signinUrl: 'https://sso.mju.ac.th/signin.aspx', callbackUrl: 'https://rae.example.test/cb', signoutUrl: 'https://sso.mju.ac.th/signout.aspx' } });
  try {
    const login = await insecure.call('/auth/sso/login');
    assert.equal(login.status, 503);
    assert.equal(errorCode(login), 'CONFIG_ERROR');
    assert.equal(insecure.mju.requests.length, 0);
  } finally {
    insecure.close();
  }

  const secure = await start({
    env: 'production',
    sso: {
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      callbackUrl: 'https://rae.example.test/api/v1/auth/sso/callback',
      tokenUrl: 'https://sso.mju.ac.th/token.aspx',
    },
  });
  try {
    const login = await secure.call('/auth/sso/login');
    assert.equal(login.status, 302);
    assert.match(login.setCookie[0], /HttpOnly/i);
    assert.match(login.setCookie[0], /SameSite=Lax/i);
    assert.match(login.setCookie[0], /Path=\/api\/v1\/auth\/sso/);
    assert.match(login.setCookie[0], /;\s*Secure/i);
    assert.equal(secure.mju.requests.length, 0);
  } finally {
    secure.close();
  }
});

// -------------------------------------------------------------------------------------- unit: normalizer

test('normalizeMjuIdentityResponse keeps only the subject and the citizen ID', () => {
  const profile = normalizeMjuIdentityResponse(identityDoc(), { subjectClaim: 'humanID', ac: GOOD_AC });
  assert.deepEqual(profile, { sub: 'H-100234', citizenID: MJU_NATIONAL });
  assert.equal(JSON.stringify(profile).includes(SYNTHETIC_NAME), false);

  // numeric JSON values are accepted (the sample deserializes into string properties)
  assert.equal(normalizeMjuIdentityResponse({ citizenID: MJU_NATIONAL, humanID: 4711 }, { subjectClaim: 'humanID' }).sub, '4711');
  assert.equal(normalizeMjuIdentityResponse({ citizenID: MJU_NATIONAL, personID: 100234 }, { subjectClaim: 'personID' }).sub, '100234');
  assert.throws(() => normalizeMjuIdentityResponse(identityDoc(), { subjectClaim: 'citizenID' }), (err) => err.code === 'SSO_NOT_READY');
  assert.throws(() => normalizeMjuIdentityResponse(null, {}), (err) => err.code === 'SSO_CODE_INVALID');
  assert.throws(
    () => normalizeMjuIdentityResponse(identityDoc({ humanID: ['H-1', 'H-2'] }), { subjectClaim: 'humanID' }),
    (err) => err.code === 'SSO_SUBJECT_AMBIGUOUS',
  );
  // personID is present and different; it is ignored, not substituted
  assert.equal(
    normalizeMjuIdentityResponse(identityDoc({ humanID: 'H-100234', personID: '999' }), { subjectClaim: 'humanID' }).sub,
    'H-100234',
  );
});
