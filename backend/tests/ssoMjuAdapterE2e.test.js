/**
 * End-to-end integration tests for MJU SSO in RAE Attendance System V2 (`SSO_PROVIDER=portal`).
 *
 * Verifies:
 *   1. Direct reuse of `@mju/sso-integration` (`v1.0.0-rc.6`) and contract parity (`C-08`, `C-14`).
 *   2. Full HTTP journey: Login -> MJU Callback (`?ac=`) -> Server-to-Server `POST token.aspx` ->
 *      Application-Scoped HMAC `subjectKey` -> Approved Identity Link -> Rotated Session ->
 *      Single-Use Handoff Exchange -> Attendance & Personal Report APIs -> Existing RBAC ->
 *      Logout -> Immediate Access-Token (`jti`) & Refresh-Token Revocation.
 *   3. Fail-closed security invariants: no auto-linking, no auto-approval, no email fallback,
 *      replay protection, browser attempt binding, handoff cookie binding, HTTP method guards,
 *      production risk-acceptance gate, rate limiting, and zero PII/token leakage.
 *
 * All identifiers are synthetic and fail the Thai mod-11 checksum (`nationalIdFixtureHygiene`).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-mju-sso-e2e-secret-32-chars';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');
const { createContainer } = require('../src/container');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const { createSsoService } = require('../src/services/ssoService');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');
const { createMariaDbLoginAttemptBackend } = require('../src/services/sso/mariadbLoginAttemptBackend');
const {
  deriveRaeSsoSubjectKey,
  loadMjuSsoStandard,
} = require('../src/services/sso/mjuPortalAdapterBridge');
const { SAMPLE_CLIENT_ID } = require('../src/services/sso/ssoSignout');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');
const { isValidNationalIdChecksum } = require('../src/security/nationalIdContract');
const { ROLES } = require('../src/services/authorizationService');

const SYNTHETIC_CLIENT_ID = 'a46a0b5374b4404a9f71a2397dcab283';
const SYNTHETIC_HMAC_KEY = 'synthetic-test-only-rae-sso-hmac-key-minimum-32-bytes!';
const APP_ID = 'rae-attendance-v2';

// Checksum-INVALID 13-digit synthetic values (verified by test below).
const SYNTHETIC_CITIZEN_EMPLOYEE = '9900000000002';
const SYNTHETIC_CITIZEN_MANAGER = '9900000000010';
const SYNTHETIC_CITIZEN_ADMIN = '9900000000028';
const SYNTHETIC_CITIZEN_UNLINKED = '9900000000036';

const EMPLOYEE_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const MANAGER_UID = '88888888-8888-8888-8888-888888888888';
const OUTSIDE_UID = '55555555-5555-5555-5555-555555555555';

let acCounter = 0;
function nextValidAc() {
  acCounter += 1;
  return `AC${String(acCounter).padStart(30, '0')}`;
}

function listen(serverOrApp) {
  const server = typeof serverOrApp.listen === 'function' && serverOrApp instanceof http.Server
    ? serverOrApp
    : http.createServer(serverOrApp);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startMockMjuProvider(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let parsedBody = null;
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsedBody = bodyText;
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody,
    });
    await handler({ req, res, body: parsedBody });
  });
  return listen(server).then(({ port }) => ({
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    signinUrl: `http://127.0.0.1:${port}/signin.aspx`,
    signoutUrl: `http://127.0.0.1:${port}/signout.aspx`,
    tokenUrl: `http://127.0.0.1:${port}/token.aspx`,
    close: () => new Promise((done) => server.close(done)),
  }));
}

function buildPortalConfig(providerUrls, overrides = {}) {
  return {
    app: {
      name: 'RAE Attendance System V2',
      env: overrides.appEnv || 'development',
      port: 0,
      url: overrides.appUrl || 'http://127.0.0.1:5173',
    },
    database: { host: '', port: 3306, name: '', user: '', password: '' },
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: '15m',
      refreshTokenDays: 14,
    },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      provider: 'portal',
      clientId: SYNTHETIC_CLIENT_ID,
      signinUrl: providerUrls.signinUrl,
      signoutUrl: providerUrls.signoutUrl,
      tokenUrl: providerUrls.tokenUrl,
      afterSignoutUrl: 'http://127.0.0.1:5173/login',
      allowedHosts: ['127.0.0.1'],
      requireHttps: false,
      allowUnverifiedContract: true,
      ownerRiskAcceptance: '',
      subjectClaim: 'citizenID',
      appId: APP_ID,
      hmacKey: SYNTHETIC_HMAC_KEY,
      lawfulBasisApproved: true,
      postLoginRedirect: '/profile',
      loginBindingCookie: 'rae_sso_bind',
      loginBindingTtlMs: 10 * 60 * 1000,
      requireLoginBinding: true,
      handoffCookie: 'rae_sso_handoff',
      handoffTtlMs: 45_000,
      codeReplayTtlMs: 60 * 60 * 1000,
      httpTimeoutMs: 2_000,
      rateLimitMax: 25,
      rateLimitWindowMs: 60_000,
      loginAttemptStore: 'memory',
      callbackDiagnostic: false,
      subjectContractConfirmed: false,
      ...(overrides.sso || {}),
    },
    corsOrigin: 'http://127.0.0.1:5173',
    attendanceCore: { url: '', timeoutMs: 8000 },
  };
}

function cookiePair(setCookieHeaders, cookieName) {
  const found = (setCookieHeaders || []).find((entry) => entry.startsWith(`${cookieName}=`));
  return found ? found.split(';')[0] : null;
}

async function httpCall(port, method, targetPath, { cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`http://127.0.0.1:${port}${targetPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get('location'),
    allow: response.headers.get('allow'),
    retryAfter: response.headers.get('retry-after'),
    cacheControl: response.headers.get('cache-control'),
    referrerPolicy: response.headers.get('referrer-policy'),
    setCookie: response.headers.getSetCookie?.() ?? [],
    body: contentType.includes('application/json') && text ? JSON.parse(text) : null,
    rawText: text,
  };
}

async function approveCitizenLink(
  repositories,
  { citizenId, employeeUid, emailSnapshot, approve = true, approvedBy = 'hr-approver@example.test' },
) {
  const subjectKey = await deriveRaeSsoSubjectKey({
    citizenId,
    hmacKey: SYNTHETIC_HMAC_KEY,
    appId: APP_ID,
  });
  const identity = createIdentityResolutionService({ repositories });
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subjectKey,
    subjectType: 'hmac_citizen_id',
    employeeUid,
    emailSnapshot,
    confidence: 'high',
    source: 'operator_review',
  });
  if (!approve) return { link: candidate, subjectKey };
  const approved = await identity.approve(candidate.id, { approvedBy });
  return { link: approved, subjectKey };
}

test('synthetic citizenID fixtures fail the Thai mod-11 checksum by design', () => {
  for (const id of [
    SYNTHETIC_CITIZEN_EMPLOYEE,
    SYNTHETIC_CITIZEN_MANAGER,
    SYNTHETIC_CITIZEN_ADMIN,
    SYNTHETIC_CITIZEN_UNLINKED,
  ]) {
    assert.equal(
      isValidNationalIdChecksum(id),
      false,
      `${id} passed mod-11 checksum; test fixtures must stay checksum-invalid`,
    );
  }
});

test('reuses @mju/sso-integration v1.0.0-rc.6 with verified C-08 and C-14 contract items', async () => {
  const standard = await loadMjuSsoStandard();
  assert.equal(standard.ADAPTER_NAME, 'mju-sso-adapter');
  assert.equal(standard.ADAPTER_VERSION, '1.0.0-rc.6');
  assert.equal(standard.CONTRACT_VERSION, '1.0.0-rc.6');
  assert.equal(standard.contractItemStatus('C-08'), 'VERIFIED');
  assert.equal(standard.contractItemStatus('C-14'), 'VERIFIED');

  const ssoService = createSsoService({
    config: buildPortalConfig({
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      tokenUrl: 'https://sso.mju.ac.th/token.aspx',
    }),
    repositories: createFixtureRepositories(),
  });
  const manifest = await ssoService.adapterManifest();
  assert.equal(manifest.adapter.version, '1.0.0-rc.6');
  assert.equal(manifest.providerCertified, false);
});

test('E2E: login -> callback -> handoff -> session -> attendance & RBAC -> logout -> revocation', async () => {
  const ac = nextValidAc();
  const provider = await startMockMjuProvider(({ res, body }) => {
    assert.equal(body.clientID, SYNTHETIC_CLIENT_ID);
    assert.equal(body.code, ac);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        citizenID: SYNTHETIC_CITIZEN_EMPLOYEE,
        humanID: 'H-EMP-001',
        personID: 'P-EMP-002',
        firstName: 'สมชาย',
        lastName: 'ตัวอย่าง',
        e_mail: 'user@example.test',
      }),
    );
  });

  const adapterLogs = [];
  const repositories = createFixtureRepositories();
  const { subjectKey } = await approveCitizenLink(repositories, {
    citizenId: SYNTHETIC_CITIZEN_EMPLOYEE,
    employeeUid: EMPLOYEE_UID,
    emailSnapshot: 'user@example.test',
  });
  assert.match(subjectKey, /^[0-9a-f]{64}$/);
  assert.equal(subjectKey.includes(SYNTHETIC_CITIZEN_EMPLOYEE), false);

  const activeConfig = buildPortalConfig(provider, {
    sso: {
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      allowedHosts: ['127.0.0.1', 'sso.mju.ac.th'],
    },
  });
  const container = createContainer({ config: activeConfig, repositories });
  const app = createApp({ container });
  const { server, port } = await listen(app);

  try {
    // 1. Login redirect
    const loginRes = await httpCall(port, 'GET', '/api/v1/auth/sso/login');
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.cacheControl, 'no-store');
    assert.equal(loginRes.referrerPolicy, 'no-referrer');
    const loginTarget = new URL(loginRes.location);
    assert.equal(`${loginTarget.origin}${loginTarget.pathname}`, provider.signinUrl);
    assert.equal(loginTarget.searchParams.get('cid'), SYNTHETIC_CLIENT_ID);

    const bindCookie = cookiePair(loginRes.setCookie, 'rae_sso_bind');
    assert.ok(bindCookie, 'rae_sso_bind HttpOnly cookie must be issued at login');

    // 2. MJU callback (?ac=...) -> server-to-server token.aspx exchange -> handoff redirect
    const callbackRes = await httpCall(
      port,
      'GET',
      `/api/v1/auth/sso/callback?ac=${encodeURIComponent(ac)}`,
      { cookie: bindCookie },
    );
    assert.equal(callbackRes.status, 302);
    assert.equal(callbackRes.cacheControl, 'no-store');
    assert.equal(callbackRes.referrerPolicy, 'no-referrer');
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].method, 'POST');
    assert.equal(provider.requests[0].url, '/token.aspx');

    // Attempt cookie burned; handoff cookie issued; zero tokens/ac/citizenID in Location URL.
    assert.ok(callbackRes.setCookie.some((c) => c.startsWith('rae_sso_bind=;')));
    const handoffCookie = cookiePair(callbackRes.setCookie, 'rae_sso_handoff');
    assert.ok(handoffCookie, 'rae_sso_handoff cookie must bind the handoff code to this browser');

    const completeUrl = new URL(callbackRes.location);
    assert.equal(completeUrl.pathname, '/auth/sso/complete');
    assert.equal(completeUrl.searchParams.get('sso'), 'success');
    const handoffCode = completeUrl.searchParams.get('code');
    assert.ok(handoffCode && handoffCode.length >= 32);
    assert.equal(callbackRes.location.includes(ac), false);
    assert.equal(callbackRes.location.includes(SYNTHETIC_CITIZEN_EMPLOYEE), false);

    // 3. Handoff exchange -> session tokens delivered to SPA
    const exchangeRes = await httpCall(port, 'POST', '/api/v1/auth/sso/exchange', {
      cookie: handoffCookie,
      body: { code: handoffCode },
    });
    assert.equal(exchangeRes.status, 200);
    assert.equal(exchangeRes.body.success, true);
    assert.ok(callbackPairCleared(exchangeRes.setCookie, 'rae_sso_handoff'));

    const { accessToken, refreshToken, employee } = exchangeRes.body.data;
    assert.ok(accessToken);
    assert.ok(refreshToken);
    assert.equal(employee.employeeUid, EMPLOYEE_UID);
    assert.equal(employee.role, 'user');

    // Handoff code is strictly single-use.
    const replayHandoff = await httpCall(port, 'POST', '/api/v1/auth/sso/exchange', {
      cookie: handoffCookie,
      body: { code: handoffCode },
    });
    assert.equal(replayHandoff.status, 401);
    assert.equal(replayHandoff.body.error.code, 'SSO_HANDOFF_INVALID');

    // 4. Authenticated session + Attendance + Personal Report + RBAC enforcement
    const ssoMe = await httpCall(port, 'GET', '/api/v1/auth/sso/me', { token: accessToken });
    assert.equal(ssoMe.status, 200);
    assert.equal(ssoMe.body.data.employeeUid, EMPLOYEE_UID);
    assert.equal(ssoMe.body.data.authMethod, 'sso');
    assert.equal(ssoMe.body.data.passwordHash, undefined);

    const ownAttendance = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${EMPLOYEE_UID}/attendance`,
      { token: accessToken },
    );
    assert.equal(ownAttendance.status, 200);
    assert.equal(Array.isArray(ownAttendance.body.data), true);
    assert.ok(ownAttendance.body.data.length >= 1);

    const ownMonthly = await httpCall(
      port,
      'GET',
      `/api/v1/attendance/monthly/${EMPLOYEE_UID}/2026/3`,
      { token: accessToken },
    );
    assert.equal(ownMonthly.status, 200);
    assert.equal(ownMonthly.body.data.employeeUid, EMPLOYEE_UID);

    const ownReport = await httpCall(
      port,
      'GET',
      '/api/v1/reports/personal?year=2026&month=3',
      { token: accessToken },
    );
    assert.equal(ownReport.status, 200);
    assert.equal(ownReport.body.data.employeeUid, EMPLOYEE_UID);

    // RBAC: EMPLOYEE cannot read another employee's attendance or org-wide daily attendance.
    const otherAttendance = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${ADMIN_UID}/attendance`,
      { token: accessToken },
    );
    assert.equal(otherAttendance.status, 403);
    assert.equal(otherAttendance.body.error.code, 'FORBIDDEN');

    const dailyForbidden = await httpCall(
      port,
      'GET',
      '/api/v1/attendance/daily/2026-03-02',
      { token: accessToken },
    );
    assert.equal(dailyForbidden.status, 403);
    assert.equal(dailyForbidden.body.error.code, 'FORBIDDEN');

    // 5. Logout revokes BOTH access token (`jti`) and refresh token before returning MJU signout URL
    const logoutRes = await httpCall(port, 'POST', '/api/v1/auth/sso/logout', {
      token: accessToken,
      body: { refreshToken },
    });
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.body.data.revoked, true);
    assert.equal(
      logoutRes.body.data.signoutUrl,
      `https://sso.mju.ac.th/signout.aspx?cid=${SYNTHETIC_CLIENT_ID}`,
    );
    assert.equal(logoutRes.body.data.afterSignoutUrl, 'http://127.0.0.1:5173/login');

    // Old access token is immediately rejected (`401 ACCESS_TOKEN_REVOKED`).
    const afterLogoutAttendance = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${EMPLOYEE_UID}/attendance`,
      { token: accessToken },
    );
    assert.equal(afterLogoutAttendance.status, 401);
    assert.equal(afterLogoutAttendance.body.error.code, 'ACCESS_TOKEN_REVOKED');

    // Old refresh token is rejected (`401 INVALID_REFRESH_TOKEN`).
    const afterLogoutRefresh = await httpCall(port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken },
    });
    assert.equal(afterLogoutRefresh.status, 401);
    assert.equal(afterLogoutRefresh.body.error.code, 'INVALID_REFRESH_TOKEN');

    // Public idempotent signout endpoint still redirects safely to MJU signout.
    const publicSignout = await httpCall(port, 'GET', '/api/v1/auth/sso/signout');
    assert.equal(publicSignout.status, 302);
    assert.equal(
      publicSignout.location,
      `https://sso.mju.ac.th/signout.aspx?cid=${SYNTHETIC_CLIENT_ID}`,
    );

    // Zero raw citizenID / ac / HMAC key anywhere in logs or HTTP payloads.
    const combinedEvidence = JSON.stringify({
      adapterLogs,
      exchangeBody: exchangeRes.body,
      ssoMeBody: ssoMe.body,
      logoutBody: logoutRes.body,
    });
    assert.equal(combinedEvidence.includes(SYNTHETIC_CITIZEN_EMPLOYEE), false);
    assert.equal(combinedEvidence.includes(ac), false);
    assert.equal(combinedEvidence.includes(SYNTHETIC_HMAC_KEY), false);
  } finally {
    if (server) server.close();
    await provider.close();
  }
});

function callbackPairCleared(setCookieHeaders, name) {
  return (setCookieHeaders || []).some((item) => item.startsWith(`${name}=;`));
}

test('RBAC with MJU SSO sessions: MANAGER sees granted org_unit only; ADMIN has directory without executive attendance', async () => {
  const managerAc = nextValidAc();
  const adminAc = nextValidAc();
  const provider = await startMockMjuProvider(({ res, body }) => {
    const citizenID =
      body.code === managerAc ? SYNTHETIC_CITIZEN_MANAGER : SYNTHETIC_CITIZEN_ADMIN;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ citizenID }));
  });

  const repositories = createFixtureRepositories();
  repositories.employees.rows.push(
    {
      employeeUid: MANAGER_UID,
      employeeId: 'E-MGR',
      firstNameTh: 'หัวหน้า',
      lastNameTh: 'ฝ่ายวิจัย',
      email: 'manager@example.test',
      passwordHash: 'x',
      department: 'ฝ่ายวิจัย',
      position: 'หัวหน้างาน',
      employeeType: 'university',
      status: 'active',
      role: 'manager',
      lockedUntil: null,
    },
    {
      employeeUid: OUTSIDE_UID,
      employeeId: 'E-OUT',
      firstNameTh: 'ต่าง',
      lastNameTh: 'หน่วยงาน',
      email: 'outside@example.test',
      passwordHash: 'x',
      department: 'ฝ่ายอื่น',
      position: 'เจ้าหน้าที่',
      employeeType: 'university',
      status: 'active',
      role: 'user',
      lockedUntil: null,
    },
  );
  // Grant MANAGER scope over ORG-RES, containing EMPLOYEE_UID but NOT OUTSIDE_UID.
  repositories.authorization = {
    async grantsFor(uid) {
      if (uid === MANAGER_UID) {
        return [{ scopeType: 'org_unit', role: ROLES.MANAGER, orgUnitCode: 'ORG-RES' }];
      }
      return [];
    },
    async uidsInOrgUnits(codes) {
      return codes.includes('ORG-RES') ? [EMPLOYEE_UID] : [];
    },
  };

  let server = null;
  let port = 0;

  async function completeSsoLogin(ac) {
    const login = await httpCall(port, 'GET', '/api/v1/auth/sso/login');
    const bind = cookiePair(login.setCookie, 'rae_sso_bind');
    const cb = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${ac}`, { cookie: bind });
    const handoffCookie = cookiePair(cb.setCookie, 'rae_sso_handoff');
    const code = new URL(cb.location).searchParams.get('code');
    const ex = await httpCall(port, 'POST', '/api/v1/auth/sso/exchange', {
      cookie: handoffCookie,
      body: { code },
    });
    assert.equal(ex.status, 200);
    return ex.body.data.accessToken;
  }

  try {
    await approveCitizenLink(repositories, {
      citizenId: SYNTHETIC_CITIZEN_MANAGER,
      employeeUid: MANAGER_UID,
      emailSnapshot: 'manager@example.test',
    });
    await approveCitizenLink(repositories, {
      citizenId: SYNTHETIC_CITIZEN_ADMIN,
      employeeUid: ADMIN_UID,
      emailSnapshot: 'admin@example.test',
    });

    const activeConfig = buildPortalConfig(provider);
    const app = createApp({ container: createContainer({ config: activeConfig, repositories }) });
    ({ server, port } = await listen(app));

    const managerToken = await completeSsoLogin(managerAc);
    // Granted member -> 200
    const grantedMember = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${EMPLOYEE_UID}/attendance`,
      { token: managerToken },
    );
    assert.equal(grantedMember.status, 200);

    // Daily attendance filtered to granted org unit -> 200
    const daily = await httpCall(port, 'GET', '/api/v1/attendance/daily/2026-03-02', {
      token: managerToken,
    });
    assert.equal(daily.status, 200);

    // Employee outside granted org unit -> 403 FORBIDDEN
    const outsideMember = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${OUTSIDE_UID}/attendance`,
      { token: managerToken },
    );
    assert.equal(outsideMember.status, 403);

    const adminToken = await completeSsoLogin(adminAc);
    // ADMIN sees employee directory -> 200
    const directory = await httpCall(port, 'GET', '/api/v1/employees', { token: adminToken });
    assert.equal(directory.status, 200);
    assert.ok(directory.body.data.length >= 3);

    // ADMIN does NOT automatically get executive attendance scope -> 403 FORBIDDEN
    const adminOtherAttendance = await httpCall(
      port,
      'GET',
      `/api/v1/employees/${EMPLOYEE_UID}/attendance`,
      { token: adminToken },
    );
    assert.equal(adminOtherAttendance.status, 403);
  } finally {
    if (server) server.close();
    await provider.close();
  }
});

test('fail-closed: unlinked, candidate, revoked, provenance-missing, disabled, and locked identities never get sessions or auto-links', async () => {
  const provider = await startMockMjuProvider(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ citizenID: body._resolvedCitizen }));
  });

  // Custom router per ac -> citizenID
  const acToCitizen = new Map();
  await provider.close();
  const mappedProvider = await startMockMjuProvider(({ res, body }) => {
    const citizenID = acToCitizen.get(body.code) || SYNTHETIC_CITIZEN_UNLINKED;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ citizenID }));
  });

  const repositories = createFixtureRepositories();
  let mintedRefreshTokens = 0;
  const origSave = repositories.refreshTokens.save.bind(repositories.refreshTokens);
  repositories.refreshTokens.save = async (row) => {
    mintedRefreshTokens += 1;
    return origSave(row);
  };

  const activeConfig = buildPortalConfig(mappedProvider);
  const ssoService = createSsoService({ config: activeConfig, repositories });

  async function attemptCallbackFor(citizenId) {
    const ac = nextValidAc();
    acToCitizen.set(ac, citizenId);
    const binding = `binding-${ac}`;
    await ssoService.beginLogin({ browserBinding: binding });
    return ssoService.handleCallback({
      method: 'GET',
      rawQuery: { ac },
      browserBinding: binding,
    });
  }

  try {
    // 1. Unlinked citizenID -> 403 SSO_IDENTITY_UNLINKED, zero auto-created link
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_UNLINKED),
      (err) => err.status === 403 && err.code === 'SSO_IDENTITY_UNLINKED',
    );
    const unlinkedKey = await deriveRaeSsoSubjectKey({
      citizenId: SYNTHETIC_CITIZEN_UNLINKED,
      hmacKey: SYNTHETIC_HMAC_KEY,
      appId: APP_ID,
    });
    assert.equal(
      await repositories.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, unlinkedKey),
      null,
      'unlinked SSO login must never create a candidate or approved link automatically',
    );

    // 2. Candidate (pending) link -> 403 SSO_IDENTITY_NOT_APPROVED, stays candidate
    const { link: candidateLink } = await approveCitizenLink(repositories, {
      citizenId: SYNTHETIC_CITIZEN_EMPLOYEE,
      employeeUid: EMPLOYEE_UID,
      emailSnapshot: 'user@example.test',
      approve: false,
    });
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_EMPLOYEE),
      (err) => err.status === 403 && err.code === 'SSO_IDENTITY_NOT_APPROVED',
    );
    assert.equal((await repositories.identityLinks.findById(candidateLink.id)).status, 'candidate');

    // 3. Approved link missing provenance -> 403 IDENTITY_PROVENANCE_INVALID
    await repositories.identityLinks.updateLink(candidateLink.id, {
      status: 'approved',
      approvedBy: null,
      approvedAt: null,
    });
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_EMPLOYEE),
      (err) => err.status === 403 && err.code === 'IDENTITY_PROVENANCE_INVALID',
    );

    // 4. Revoked link -> 403 SSO_IDENTITY_NOT_APPROVED
    await repositories.identityLinks.updateLink(candidateLink.id, {
      status: 'revoked',
      approvedBy: 'reviewer@example.test',
      approvedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_EMPLOYEE),
      (err) => err.status === 403 && err.code === 'SSO_IDENTITY_NOT_APPROVED',
    );

    // 5. Disabled employee -> 403 SSO_IDENTITY_DISABLED
    const inactiveUid = '66666666-6666-6666-6666-666666666666';
    repositories.employees.rows.push({
      employeeUid: inactiveUid,
      employeeId: 'E-DIS',
      firstNameTh: 'ปิด',
      lastNameTh: 'บัญชี',
      email: 'disabled@example.test',
      passwordHash: 'x',
      department: 'วิจัย',
      position: 'เจ้าหน้าที่',
      employeeType: 'university',
      status: 'inactive',
      role: 'user',
      lockedUntil: null,
    });
    await approveCitizenLink(repositories, {
      citizenId: SYNTHETIC_CITIZEN_MANAGER,
      employeeUid: inactiveUid,
      emailSnapshot: 'disabled@example.test',
    });
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_MANAGER),
      (err) => err.status === 403 && err.code === 'SSO_IDENTITY_DISABLED',
    );

    // 6. Locked employee -> 403 ACCOUNT_LOCKED
    const lockedUid = '77777777-7777-7777-7777-777777777777';
    repositories.employees.rows.push({
      employeeUid: lockedUid,
      employeeId: 'E-LOCK2',
      firstNameTh: 'ระงับ',
      lastNameTh: 'ชั่วคราว',
      email: 'sso-locked@example.test',
      passwordHash: 'x',
      department: 'วิจัย',
      position: 'เจ้าหน้าที่',
      employeeType: 'university',
      status: 'active',
      role: 'user',
      lockedUntil: new Date(Date.now() + 600_000).toISOString(),
    });
    await approveCitizenLink(repositories, {
      citizenId: SYNTHETIC_CITIZEN_ADMIN,
      employeeUid: lockedUid,
      emailSnapshot: 'sso-locked@example.test',
    });
    await assert.rejects(
      () => attemptCallbackFor(SYNTHETIC_CITIZEN_ADMIN),
      (err) => err.status === 403 && err.code === 'ACCOUNT_LOCKED',
    );

    assert.equal(mintedRefreshTokens, 0, 'zero sessions may be minted across all denial cases');
  } finally {
    await mappedProvider.close();
  }
});

test('protocol & transport guards: replay, duplicate ac, missing/wrong binding, HTTP 405, provider errors, handoff binding, rate limit', async () => {
  let providerMode = 'ok';
  const provider = await startMockMjuProvider(({ res }) => {
    if (providerMode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_code' }));
      return;
    }
    if (providerMode === '500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream error');
      return;
    }
    if (providerMode === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-json');
      return;
    }
    if (providerMode === 'missing-citizen') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ humanID: 'H-1' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ citizenID: SYNTHETIC_CITIZEN_EMPLOYEE }));
  });

  const repositories = createFixtureRepositories();
  await approveCitizenLink(repositories, {
    citizenId: SYNTHETIC_CITIZEN_EMPLOYEE,
    employeeUid: EMPLOYEE_UID,
    emailSnapshot: 'user@example.test',
  });

  const activeConfig = buildPortalConfig(provider, {
    sso: { rateLimitMax: 12, rateLimitWindowMs: 60_000 },
  });
  const app = createApp({ container: createContainer({ config: activeConfig, repositories }) });
  const { server, port } = await listen(app);

  async function startBoundAttempt() {
    const login = await httpCall(port, 'GET', '/api/v1/auth/sso/login');
    assert.equal(login.status, 302);
    return cookiePair(login.setCookie, 'rae_sso_bind');
  }

  try {
    // 1. Method guards (405 + Allow header)
    const postCallback = await httpCall(port, 'POST', '/api/v1/auth/sso/callback?ac=' + nextValidAc());
    assert.equal(postCallback.status, 405);
    assert.equal(postCallback.allow, 'GET');

    const getLogout = await httpCall(port, 'GET', '/api/v1/auth/sso/logout');
    assert.equal(getLogout.status, 405);
    assert.equal(getLogout.allow, 'POST');

    const getExchange = await httpCall(port, 'GET', '/api/v1/auth/sso/exchange');
    assert.equal(getExchange.status, 405);
    assert.equal(getExchange.allow, 'POST');

    // 2. Duplicate ac parameter (?ac=one&ac=two) -> 400 SSO_CALLBACK_DUPLICATE
    const bindDup = await startBoundAttempt();
    const dupRes = await httpCall(
      port,
      'GET',
      `/api/v1/auth/sso/callback?ac=${nextValidAc()}&ac=${nextValidAc()}`,
      { cookie: bindDup },
    );
    assert.equal(dupRes.status, 400);
    assert.equal(dupRes.body.error.code, 'SSO_CALLBACK_DUPLICATE');

    // 3. Missing binding cookie -> 403 SSO_ATTEMPT_MISSING (never contacts MJU)
    const countBefore = provider.requests.length;
    const missingBind = await httpCall(
      port,
      'GET',
      `/api/v1/auth/sso/callback?ac=${nextValidAc()}`,
    );
    assert.equal(missingBind.status, 403);
    assert.equal(missingBind.body.error.code, 'SSO_ATTEMPT_MISSING');
    assert.equal(provider.requests.length, countBefore);

    // 4. Invalid ac shape -> 400 SSO_CALLBACK_INVALID
    const bindInvalidAc = await startBoundAttempt();
    const badAc = await httpCall(port, 'GET', '/api/v1/auth/sso/callback?ac=too-short', {
      cookie: bindInvalidAc,
    });
    assert.equal(badAc.status, 400);
    assert.equal(badAc.body.error.code, 'SSO_CALLBACK_INVALID');

    // 5. Replayed ac across two fresh browser attempts -> second fails 403 SSO_CODE_REPLAY
    const sharedAc = nextValidAc();
    const bindFirst = await startBoundAttempt();
    const firstOk = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${sharedAc}`, {
      cookie: bindFirst,
    });
    assert.equal(firstOk.status, 302);

    // Also verify handoff code fails when presented without its matching rae_sso_handoff cookie
    const stolenHandoffCode = new URL(firstOk.location).searchParams.get('code');
    const wrongBrowserExchange = await httpCall(port, 'POST', '/api/v1/auth/sso/exchange', {
      cookie: 'rae_sso_handoff=attacker-browser-cookie-value-000000',
      body: { code: stolenHandoffCode },
    });
    assert.equal(wrongBrowserExchange.status, 401);
    assert.equal(wrongBrowserExchange.body.error.code, 'SSO_HANDOFF_INVALID');

    const bindSecond = await startBoundAttempt();
    const replayedAc = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${sharedAc}`, {
      cookie: bindSecond,
    });
    assert.equal(replayedAc.status, 403);
    assert.equal(replayedAc.body.error.code, 'SSO_CODE_REPLAY');

    // 6. Provider failures: 401, 500, invalid JSON, missing citizenID
    providerMode = '401';
    const r401 = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${nextValidAc()}`, {
      cookie: await startBoundAttempt(),
    });
    assert.equal(r401.status, 401);
    assert.equal(r401.body.error.code, 'SSO_CODE_REJECTED');

    providerMode = '500';
    const r500 = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${nextValidAc()}`, {
      cookie: await startBoundAttempt(),
    });
    assert.equal(r500.status, 502);
    assert.equal(r500.body.error.code, 'SSO_PROVIDER_ERROR');

    providerMode = 'bad-json';
    const rJson = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${nextValidAc()}`, {
      cookie: await startBoundAttempt(),
    });
    assert.equal(rJson.status, 502);
    assert.equal(rJson.body.error.code, 'SSO_RESPONSE_INVALID');

    providerMode = 'missing-citizen';
    const rMissing = await httpCall(port, 'GET', `/api/v1/auth/sso/callback?ac=${nextValidAc()}`, {
      cookie: await startBoundAttempt(),
    });
    assert.equal(rMissing.status, 502);
    assert.equal(rMissing.body.error.code, 'SSO_RESPONSE_INVALID');

    // 7. Rate limit ceiling returns 429 with Retry-After header
    let saw429 = false;
    for (let i = 0; i < 15; i += 1) {
      const r = await httpCall(port, 'GET', '/api/v1/auth/sso/login');
      if (r.status === 429) {
        saw429 = true;
        assert.equal(r.body.error.code, 'SSO_RATE_LIMITED');
        assert.ok(Number(r.retryAfter) >= 1);
        break;
      }
    }
    assert.equal(saw429, true, 'expected /auth/sso/login to enforce 429 rate limiting');
  } finally {
    if (server) server.close();
    await provider.close();
  }
});

test('production & configuration gates: sample client ID, lawful basis, HMAC key, HTTPS, private host, and owner risk acceptance', async () => {
  const httpsUrls = {
    signinUrl: 'https://sso.mju.ac.th/signin.aspx',
    signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
    tokenUrl: 'https://sso.mju.ac.th/token.aspx',
  };

  // Sample client ID is refused loudly.
  const sampleService = createSsoService({
    config: buildPortalConfig(httpsUrls, {
      sso: {
        clientId: SAMPLE_CLIENT_ID,
        allowedHosts: ['sso.mju.ac.th'],
        requireHttps: true,
      },
    }),
    repositories: createFixtureRepositories(),
  });
  await assert.rejects(
    () => sampleService.beginLogin({ browserBinding: 'b'.repeat(32) }),
    (err) => err.status === 503 && err.code === 'SSO_CLIENT_ID_IS_SAMPLE',
  );

  // Confidential citizenID without lawfulBasisApproved or HMAC key fails closed on callback.
  const noLawfulBasis = createSsoService({
    config: buildPortalConfig(httpsUrls, {
      sso: {
        allowedHosts: ['sso.mju.ac.th'],
        requireHttps: true,
        lawfulBasisApproved: false,
      },
    }),
    repositories: createFixtureRepositories(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ citizenID: SYNTHETIC_CITIZEN_EMPLOYEE }),
    }),
  });
  const b1 = 'binding-no-lawful-basis-32-characters';
  await noLawfulBasis.beginLogin({ browserBinding: b1 });
  await assert.rejects(
    () => noLawfulBasis.handleCallback({ method: 'GET', rawQuery: { ac: nextValidAc() }, browserBinding: b1 }),
    (err) => err.status === 503 && err.code === 'SSO_CONFIG_INVALID',
  );

  // Production refuses requireHttps=false, private hosts, and unverified contract without risk acceptance.
  const prodNoHttps = createSsoService({
    config: buildPortalConfig(httpsUrls, {
      appEnv: 'Production', // case-insensitive check
      sso: {
        allowedHosts: ['sso.mju.ac.th'],
        requireHttps: false,
      },
    }),
    repositories: createFixtureRepositories(),
  });
  await assert.rejects(
    () => prodNoHttps.beginLogin({ browserBinding: 'b'.repeat(32) }),
    (err) => err.status === 503 && err.code === 'SSO_CONFIG_INVALID',
  );

  const prodPrivateHost = createSsoService({
    config: buildPortalConfig(
      {
        signinUrl: 'https://127.0.0.1/signin.aspx',
        signoutUrl: 'https://127.0.0.1/signout.aspx',
        tokenUrl: 'https://127.0.0.1/token.aspx',
      },
      {
        appEnv: 'production',
        sso: { allowedHosts: ['127.0.0.1'], requireHttps: true },
      },
    ),
    repositories: createFixtureRepositories(),
  });
  await assert.rejects(
    () => prodPrivateHost.beginLogin({ browserBinding: 'b'.repeat(32) }),
    (err) => err.status === 503 && err.code === 'SSO_UNTRUSTED_ENDPOINT',
  );

  const prodMissingAcceptance = createSsoService({
    config: buildPortalConfig(httpsUrls, {
      appEnv: 'production',
      sso: { allowedHosts: ['sso.mju.ac.th'], requireHttps: true, ownerRiskAcceptance: '' },
    }),
    repositories: createFixtureRepositories(),
  });
  await assert.rejects(
    () => prodMissingAcceptance.beginLogin({ browserBinding: 'b'.repeat(32) }),
    (err) => err.status === 503 && err.code === 'SSO_CONFIG_INVALID',
  );

  // Production WITH a recorded owner risk acceptance covering every unverified item succeeds.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rae-sso-prod-risk-'));
  try {
    const riskPath = path.join(tmpDir, 'risk.json');
    fs.writeFileSync(
      riskPath,
      JSON.stringify({
        decision: 'accepted-owner-risk',
        providerCertified: false,
        authorisedBy: 'Synthetic Owner Test',
        date: '2026-11-17',
        acceptedItems: [
          'C-01',
          'C-02',
          'C-03',
          'C-04',
          'C-05',
          'C-06',
          'C-07',
          'C-09',
          'C-10',
          'C-11',
          'C-12',
          'C-13',
        ],
        controls: ['approved-link gate', 'application-scoped HMAC subjectKey'],
      }),
      'utf8',
    );
    const prodAccepted = createSsoService({
      config: buildPortalConfig(httpsUrls, {
        appEnv: 'production',
        sso: {
          allowedHosts: ['sso.mju.ac.th'],
          requireHttps: true,
          ownerRiskAcceptance: riskPath,
        },
      }),
      repositories: createFixtureRepositories(),
    });
    const redirectUrl = await prodAccepted.beginLogin({ browserBinding: 'b'.repeat(32) });
    assert.equal(redirectUrl, `https://sso.mju.ac.th/signin.aspx?cid=${SYNTHETIC_CLIENT_ID}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MariaDB backend claimOnce distinguishes duplicate replay (false) from DB failure (503)', async () => {
  const seen = new Set();
  let failDb = false;
  const fakePool = {
    async query() {
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params) {
          if (failDb) {
            const err = new Error('ER_NO_SUCH_TABLE');
            err.code = 'ER_NO_SUCH_TABLE';
            throw err;
          }
          if (sql.startsWith('INSERT INTO sso_login_attempt')) {
            const digest = params[0];
            if (seen.has(digest)) {
              const dup = new Error('Duplicate entry');
              dup.code = 'ER_DUP_ENTRY';
              dup.errno = 1062;
              throw dup;
            }
            seen.add(digest);
          }
          return [{ affectedRows: 1 }];
        },
      };
    },
  };

  const store = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(fakePool) });
  const ac = nextValidAc();
  assert.equal(await store.claimCodeOnce(ac), true);
  assert.equal(await store.claimCodeOnce(ac), false, 'duplicate entry must map to false (replay)');

  failDb = true;
  await assert.rejects(
    () => store.claimCodeOnce(nextValidAc()),
    (err) => err.status === 503 && err.code === 'SSO_LOGIN_STORE_UNAVAILABLE',
  );
});
