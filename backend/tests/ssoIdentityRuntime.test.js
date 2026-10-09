require('./helpers/syntheticIdentifierKeys');
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createSsoIdentityResolutionService } = require('../src/services/ssoIdentityResolutionService');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const userUid = '22222222-2222-2222-2222-222222222222';
const fakeCitizenId = '9900000000001';

function baseConfig(overrides = {}) {
  return {
    jwt: { secret: process.env.JWT_SECRET, expiresIn: '15m', refreshTokenDays: 14 },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      subjectContractConfirmed: true,
      nationalIdClaims: '',
      authorizationUrl: 'https://sso.example.test/oauth/authorize',
      tokenUrl: 'https://sso.example.test/oauth/token',
      userInfoUrl: 'https://sso.example.test/oauth/userinfo',
      clientId: 'v2-client-id',
      clientSecret: 'v2-client-secret',
      callbackUrl: 'http://127.0.0.1:3210/api/v1/auth/sso/callback',
      ...(overrides.sso || {}),
    },
  };
}

function runtime(repositories, configOverrides = {}) {
  return createSsoIdentityResolutionService({
    config: baseConfig(configOverrides),
    repositories,
  });
}

test('known national_id resolves to employee_uid and issues JWT', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  const session = await service.issueSessionFromOAuthProfile({
    profile: { citizenID: fakeCitizenId, sub: 'runtime-subject-a' },
  });
  assert.equal(session.employee.employeeUid, userUid);
  const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.sub, userUid);
  assert.equal(payload.national_id, undefined);
});

test('provider_subject already linked logs in without national_id in profile', async () => {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  const subject = 'runtime-linked-subject';
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: userUid,
    emailSnapshot: 'user@example.test',
    source: 'operator_review',
  });
  await identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' });

  const service = runtime(repositories);
  const session = await service.issueSessionFromOAuthProfile({
    profile: { sub: subject },
  });
  assert.equal(session.resolutionPath, 'provider_subject');
  assert.equal(session.employee.employeeUid, userUid);
});

test('first login creates approved provider link when national_id resolves', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  const subject = 'runtime-first-login-subject';
  await service.issueSessionFromOAuthProfile({
    profile: { citizenID: fakeCitizenId, sub: subject, email: 'user@example.test' },
  });
  const link = await repositories.identityLinks.findByProviderSubject(PROVIDER_MJU_SSO, subject);
  assert.ok(link);
  assert.equal(link.status, 'approved');
  assert.equal(link.employeeUid, userUid);
});

test('unknown national_id is denied', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  await assert.rejects(
    () => service.issueSessionFromOAuthProfile({
      profile: { citizenID: '9900000000099', sub: 'unknown-subject' },
    }),
    (err) => err.code === 'SSO_USER_UNKNOWN',
  );
});

test('conflicting provider subject is rejected', async () => {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  const subject = 'runtime-conflict-subject';
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: '11111111-1111-1111-1111-111111111111',
    emailSnapshot: 'admin@example.test',
    source: 'operator_review',
  });
  await identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' });

  const service = runtime(repositories);
  await assert.rejects(
    () => service.issueSessionFromOAuthProfile({
      profile: { citizenID: fakeCitizenId, sub: subject },
    }),
    (err) => err.code === 'IDENTITY_SUBJECT_CONFLICT',
  );
});

test('email mismatch does not change canonical employee mapping', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  const session = await service.issueSessionFromOAuthProfile({
    profile: {
      citizenID: fakeCitizenId,
      sub: 'runtime-email-mismatch-subject',
      email: 'different@example.test',
    },
  });
  assert.equal(session.employee.employeeUid, userUid);
  assert.equal(session.employee.email, 'user@example.test');
});

test('missing citizen ID claim is rejected', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  await assert.rejects(
    () => service.issueSessionFromOAuthProfile({ profile: { sub: 'subject-without-citizen' } }),
    (err) => err.code === 'SSO_NATIONAL_ID_MISSING',
  );
});

test('inactive employee is rejected after national_id resolution', async () => {
  const repositories = createFixtureRepositories();
  const inactiveUid = '44444444-4444-4444-4444-444444444444';
  repositories.employees.rows.push({
    employeeUid: inactiveUid,
    employeeId: 'E-INACTIVE-RUNTIME',
    firstNameTh: 'ไม่ใช้',
    lastNameTh: 'งาน',
    email: 'inactive-runtime@example.test',
    passwordHash: 'x',
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    status: 'inactive',
    role: 'user',
    lockedUntil: null,
  });
  const employeeIdentity = createEmployeeIdentityService({ repositories });
  await employeeIdentity.linkIdentifier({
    employeeUid: inactiveUid,
    idType: 'national_id',
    idValue: '9900000000003',
  });

  const service = runtime(repositories);
  await assert.rejects(
    () => service.issueSessionFromOAuthProfile({
      profile: { citizenID: '9900000000003', sub: 'inactive-runtime-subject' },
    }),
    (err) => err.code === 'SSO_USER_DISABLED',
  );
});

test('JWT omits national_id and session uses employee_uid', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  const session = await service.issueSessionFromOAuthProfile({
    profile: { citizenID: fakeCitizenId, sub: 'runtime-jwt-subject' },
  });
  const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.sub, userUid);
  assert.equal(Object.hasOwn(payload, 'national_id'), false);
  assert.equal(Object.hasOwn(payload, 'citizenID'), false);
});

test('name fields alone do not authenticate', async () => {
  const repositories = createFixtureRepositories();
  const service = runtime(repositories);
  await assert.rejects(
    () => service.issueSessionFromOAuthProfile({
      profile: { firstName: 'ผู้ใช้', lastName: 'ตัวอย่าง', email: 'user@example.test' },
    }),
    (err) => err.code === 'SSO_NATIONAL_ID_MISSING',
  );
});

test('national_id adapter test file uses anonymized fake IDs only', async () => {
  const { extractNationalIdFromProfile } = require('../src/services/sso/mjuNationalIdAdapter');
  const out = extractNationalIdFromProfile({ citizenID: fakeCitizenId }, '');
  assert.equal(out.status, 'present');
  assert.equal(out.normalized, fakeCitizenId);
  assert.match(out.masked, /\*\*\*\*/);
});
