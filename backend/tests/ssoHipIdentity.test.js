/**
 * SSO integration (synthetic identities + mock OAuth provider): MJU, HIP-only, unmapped and invalid-token paths
 * through createSsoService.handleCallback. No network, no real IDs, no real keys.
 */
require('./helpers/syntheticIdentifierKeys');
const { TEST_BINDING } = require('./helpers/ssoTestBinding');
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createSsoService } = require('../src/services/ssoService');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { HttpError } = require('../src/utils/httpError');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const MJU_UID = '11111111-1111-1111-1111-111111111111'; // MJU person: personnel_id + national (HMAC) + HIP id
const HIP_UID = '22222222-2222-2222-2222-222222222222'; // contractor: HIP id + national (HMAC), NO personnel_id
const MJU_NATIONAL = '9900000000011'; // synthetic
const HIP_NATIONAL = '9900000000012'; // synthetic
const UNKNOWN_NATIONAL = '9900000000099'; // synthetic, in nobody's record

function seededRepositories() {
  return createFixtureRepositories({
    identifiers: [
      { employeeUid: MJU_UID, idType: 'personnel_id', idValue: 'PX-00001', sourceSystem: 'mju_person_api' },
      { employeeUid: MJU_UID, idType: 'national_id', idValue: MJU_NATIONAL, sourceSystem: 'IDCardRaecsv2027' },
      { employeeUid: MJU_UID, idType: 'facescan_id', idValue: 'HX0001', sourceSystem: 'IDCardRaecsv2027' },
      { employeeUid: HIP_UID, idType: 'facescan_id', idValue: 'HX0002', sourceSystem: 'IDCardRaecsv2027', isPrimary: true },
      { employeeUid: HIP_UID, idType: 'national_id', idValue: HIP_NATIONAL, sourceSystem: 'IDCardRaecsv2027' },
    ],
  });
}

function configFor(overrides = {}) {
  return {
    jwt: { secret: 'test-only-secret', expiresIn: '15m', refreshTokenDays: 14 },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      protocolContractConfirmed: true,
      subjectContractConfirmed: true,
      nationalIdClaims: 'citizenID',
      authorizationUrl: 'https://sso.example.test/oauth/authorize',
      tokenUrl: 'https://sso.example.test/oauth/token',
      userInfoUrl: 'https://sso.example.test/oauth/userinfo',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
      scopes: 'openid profile',
      ...(overrides.sso || {}),
    },
  };
}

/** Mock provider: codes map to scripted outcomes; nothing leaves the process. */
function mockProvider({ profile = {}, tokenResponse = { access_token: 'synthetic-access', token_type: 'Bearer' }, userInfoError = null, codeError = null } = {}) {
  const calls = { exchange: 0, userinfo: 0 };
  return {
    calls,
    kind: 'mock',
    buildAuthorizationUrl({ authorizationUrl, state }) {
      return `${authorizationUrl}?state=${state}`;
    },
    async exchangeCode({ code }) {
      calls.exchange += 1;
      if (codeError || code !== 'good-code') throw codeError || new HttpError(401, 'SSO_TOKEN_ERROR', 'Authorization code is invalid');
      return tokenResponse;
    },
    async fetchUserInfo({ accessToken }) {
      calls.userinfo += 1;
      if (userInfoError) throw userInfoError;
      if (accessToken !== 'synthetic-access') throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request');
      return profile;
    },
  };
}

async function login(sso, code = 'good-code') {
  const url = await sso.beginLogin({ browserBinding: TEST_BINDING });
  const state = new URL(url).searchParams.get('state');
  return sso.handleCallback({ code, state, browserBinding: TEST_BINDING });
}

function setup(providerOptions, configOverrides) {
  const repositories = seededRepositories();
  const provider = mockProvider(providerOptions);
  const sso = createSsoService({ config: configFor(configOverrides), repositories, oauthProvider: provider });
  const identity = createEmployeeIdentityService({ repositories });
  return { repositories, provider, sso, identity };
}

const noLink = async (repositories, subject) => assert.equal(await repositories.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, subject), null);

test('MJU person: first login links the subject from the verified callback, then subject-only login works', async () => {
  const { repositories, sso, identity } = setup({ profile: { citizenID: MJU_NATIONAL, sub: 'subject-mju-1', email: 'admin@example.test' } });
  assert.equal((await identity.getIdentityKind(MJU_UID)).kind, 'MJU');
  const session = await login(sso);
  assert.equal(session.employee.employeeUid, MJU_UID);
  assert.ok(session.accessToken && session.refreshToken);
  const link = await repositories.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-mju-1');
  assert.equal(link.employeeUid, MJU_UID);
  assert.equal(link.status, 'approved');

  // later logins may rely on the linked subject alone (no national id claim)
  const again = createSsoService({ config: configFor(), repositories, oauthProvider: mockProvider({ profile: { sub: 'subject-mju-1' } }) });
  assert.equal((await login(again)).employee.employeeUid, MJU_UID);
});

test('HIP-only contractor: attendance identity works with no MJU account, no SSO link and no personnel_id', async () => {
  const { repositories, identity } = setup();
  const kind = await identity.getIdentityKind(HIP_UID);
  assert.equal(kind.kind, 'HIP');
  assert.deepEqual(kind.attendance, { eligible: true, via: 'facescan_id', requiresMjuSso: false });
  assert.equal(kind.sso.required, false);
  assert.equal(kind.sso.eligibility, 'NOT_REQUIRED');
  assert.equal(kind.sso.createSubject, false);

  // attendance resolution uses the HIP id only
  assert.equal(await identity.resolveUid('facescan_id', 'HX0002'), HIP_UID);
  const rows = await identity.listIdentifiers(HIP_UID);
  assert.ok(!rows.some((row) => row.idType === 'personnel_id'));
  // nothing created an SSO subject for the contractor
  assert.equal(await repositories.identityLinks.findApprovedForEmployee(HIP_UID, 1), null);
});

test('HIP contractor who later has an MJU account: verified login links the subject to the SAME employee; kind stays HIP until MJU personnel_id is attached', async () => {
  const { repositories, sso, identity } = setup({ profile: { citizenID: HIP_NATIONAL, sub: 'subject-hip-1' } });
  const session = await login(sso);
  assert.equal(session.employee.employeeUid, HIP_UID);
  assert.equal((await repositories.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, 'subject-hip-1')).employeeUid, HIP_UID);
  const kind = await identity.getIdentityKind(HIP_UID);
  assert.equal(kind.kind, 'HIP', 'SSO login must not fabricate a personnel_id');
  assert.ok(!(await identity.listIdentifiers(HIP_UID)).some((row) => row.idType === 'personnel_id'));
  // upgrade only through an explicit MJU-sourced personnel_id
  await assert.rejects(
    () => identity.linkIdentifier({ employeeUid: HIP_UID, idType: 'personnel_id', idValue: 'PX-00002', sourceSystem: 'sso_login' }),
    (error) => error.code === 'PERSONNEL_ID_SOURCE_REQUIRED',
  );
  await identity.linkIdentifier({ employeeUid: HIP_UID, idType: 'personnel_id', idValue: 'PX-00002', sourceSystem: 'mju_person_api' });
  assert.equal((await identity.getIdentityKind(HIP_UID)).kind, 'MJU');
});

test('unmapped identities are denied without creating employees, identifiers, links or sessions', async () => {
  const cases = [
    [{ citizenID: UNKNOWN_NATIONAL, sub: 'subject-unmapped' }, 'SSO_USER_UNKNOWN', 403],
    [{ sub: 'subject-no-national' }, 'SSO_NATIONAL_ID_MISSING', 403],
    [{ citizenID: '12345', sub: 'subject-bad-national' }, 'SSO_NATIONAL_ID_INVALID', 403],
    [{ email: 'user@example.test', name: 'Synthetic Person', sub: 'subject-name-only' }, 'SSO_NATIONAL_ID_MISSING', 403],
  ];
  for (const [profile, code, status] of cases) {
    const { repositories, sso, identity } = setup({ profile });
    const before = (await identity.listIdentifiers(HIP_UID)).length + (await identity.listIdentifiers(MJU_UID)).length;
    await assert.rejects(() => login(sso), (error) => error.status === status && error.code === code && !String(error.message).includes(profile.citizenID || '\u0000'));
    await noLink(repositories, profile.sub);
    const after = (await identity.listIdentifiers(HIP_UID)).length + (await identity.listIdentifiers(MJU_UID)).length;
    assert.equal(after, before, 'no identifier may be created by a failed login');
    assert.equal(await repositories.refreshTokens.find('anything'), null);
  }
});

test('invalid or hostile token flow is rejected before identity resolution', async () => {
  const profile = { citizenID: MJU_NATIONAL, sub: 'subject-invalid' };

  // bad authorization code
  let ctx = setup({ profile });
  await assert.rejects(() => login(ctx.sso, 'bad-code'), (e) => e.status === 401 && e.code === 'SSO_TOKEN_ERROR');
  assert.equal(ctx.provider.calls.userinfo, 0);
  await noLink(ctx.repositories, profile.sub);

  // provider answers without an access token
  ctx = setup({ profile, tokenResponse: { token_type: 'Bearer' } });
  await assert.rejects(() => login(ctx.sso), (e) => e.status === 502 && e.code === 'SSO_TOKEN_ERROR');
  assert.equal(ctx.provider.calls.userinfo, 0);

  // userinfo rejects the (invalid/expired) access token
  ctx = setup({ profile, userInfoError: new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request') });
  await assert.rejects(() => login(ctx.sso), (e) => e.code === 'SSO_PROVIDER_ERROR');
  await noLink(ctx.repositories, profile.sub);

  // provider token of the wrong type is not trusted as identity: access token that userinfo refuses
  ctx = setup({ profile, tokenResponse: { access_token: 'tampered-token' } });
  await assert.rejects(() => login(ctx.sso), (e) => e.code === 'SSO_PROVIDER_ERROR');

  // state missing / unknown / replayed / provider-reported error
  ctx = setup({ profile });
  await assert.rejects(() => ctx.sso.handleCallback({ code: 'good-code', state: 'forged' }), (e) => e.status === 403 && e.code === 'SSO_STATE_INVALID');
  await assert.rejects(() => ctx.sso.handleCallback({ code: 'good-code' }), (e) => e.code === 'SSO_STATE_INVALID');
  const url = await ctx.sso.beginLogin({ browserBinding: TEST_BINDING });
  const state = new URL(url).searchParams.get('state');
  await ctx.sso.handleCallback({ code: 'good-code', state, browserBinding: TEST_BINDING });
  await assert.rejects(() => ctx.sso.handleCallback({ code: 'good-code', state, browserBinding: TEST_BINDING }), (e) => e.code === 'SSO_STATE_INVALID', 'state is single-use');
  await assert.rejects(() => ctx.sso.handleCallback({ error: 'access_denied', error_description: 'denied' }), (e) => e.status === 401 && e.code === 'SSO_DENIED');
  await assert.rejects(() => ctx.sso.handleCallback({ state }), (e) => e.status === 400 || e.code === 'SSO_STATE_INVALID');

  // SSO disabled / callback not confirmed stays closed
  for (const sso of [{ enabled: false }, { callbackConfirmed: false }]) {
    ctx = setup({ profile }, { sso });
    await assert.rejects(() => login(ctx.sso), (e) => ['SSO_DISABLED', 'SSO_NOT_READY'].includes(e.code));
  }
});

test('conflicting subject: a subject already linked to the MJU person cannot log in as the HIP contractor', async () => {
  const { repositories, identity } = setup();
  await login(createSsoService({ config: configFor(), repositories, oauthProvider: mockProvider({ profile: { citizenID: MJU_NATIONAL, sub: 'subject-shared' } }) }));
  const attacker = createSsoService({
    config: configFor(),
    repositories,
    oauthProvider: mockProvider({ profile: { citizenID: HIP_NATIONAL, sub: 'subject-shared' } }),
  });
  await assert.rejects(() => login(attacker), (e) => e.status === 409 && e.code === 'IDENTITY_SUBJECT_CONFLICT');
  assert.equal((await identity.getIdentityKind(HIP_UID)).kind, 'HIP');
});

test('logout revokes the refresh token; session carries employee_uid only (no national id)', async () => {
  const { repositories, sso } = setup({ profile: { citizenID: MJU_NATIONAL, sub: 'subject-logout' } });
  const session = await login(sso);
  const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.sub, MJU_UID);
  assert.ok(!JSON.stringify(payload).includes(MJU_NATIONAL));
  const result = await sso.logout({ refreshToken: session.refreshToken, auth: { employeeUid: MJU_UID } });
  assert.equal(result.revoked, true);
  const stored = await repositories.refreshTokens.find(session.refreshToken);
  assert.ok(stored.revokedAt, 'refresh token must be revoked');
  await assert.rejects(
    () => sso.logout({ refreshToken: session.refreshToken, auth: { employeeUid: HIP_UID } }),
    (e) => e.status === 401,
  );
});
