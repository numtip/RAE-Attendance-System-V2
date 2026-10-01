const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const { createSsoIdentityChainService } = require('../src/services/ssoIdentityChainService');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const userUid = '22222222-2222-2222-2222-222222222222';

function baseConfig(overrides = {}) {
  return {
    jwt: { secret: 'test-chain-secret', expiresIn: '15m', refreshTokenDays: 14 },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      subjectContractConfirmed: false,
      signinUrl: 'https://sso.mju.ac.th/signin.aspx',
      signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
      clientId: 'test-client',
      callbackUrl: 'https://example.test/api/v1/auth/sso/callback',
      ...(overrides.sso || {}),
    },
  };
}

function chainWithApprovedLink(subject, configOverrides = {}) {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  return identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: userUid,
    emailSnapshot: 'user@example.test',
    confidence: 'high',
    source: 'operator_review',
  }).then((candidate) => identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' }))
    .then(() => createSsoIdentityChainService({ config: baseConfig(configOverrides), repositories }));
}

test('no session when subject contract is unknown', async () => {
  const repositories = createFixtureRepositories();
  const chain = createSsoIdentityChainService({ config: baseConfig(), repositories });
  await assert.rejects(
    () => chain.issueSessionFromVerifiedInput({ query: { ac: 'b'.repeat(32) } }),
    (err) => err.status === 403 && err.code === 'SSO_SUBJECT_UNKNOWN',
  );
});

test('no session when ac is treated as subject', async () => {
  const repositories = createFixtureRepositories();
  const chain = createSsoIdentityChainService({ config: baseConfig(), repositories });
  await assert.rejects(
    () => chain.issueSessionFromVerifiedInput({ usesCallbackAc: true, subject: 'ac' }),
    (err) => err.status === 403 && err.code === 'SSO_SUBJECT_INVALID',
  );
});

test('approved identity link issues session when subject is verified', async () => {
  const subject = 'mju-chain-subject-001';
  const chain = await chainWithApprovedLink(subject, {
    sso: { subjectContractConfirmed: true },
  });
  const session = await chain.issueSessionFromVerifiedInput({
    confirmedSubject: subject,
  });
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.equal(session.employee.employeeUid, userUid);
  assert.equal(session.extraction.status, 'verified');
});

test('candidate link is denied at session issuance', async () => {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  const subject = 'mju-chain-candidate-only';
  await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: userUid,
    emailSnapshot: 'user@example.test',
    source: 'operator_review',
  });
  const chain = createSsoIdentityChainService({
    config: baseConfig({ sso: { subjectContractConfirmed: true } }),
    repositories,
  });
  await assert.rejects(
    () => chain.issueSessionFromVerifiedInput({ confirmedSubject: subject }),
    (err) => err.status === 403 && err.code === 'IDENTITY_NOT_APPROVED',
  );
});

test('revoked link is denied at session issuance', async () => {
  const repositories = createFixtureRepositories();
  const identity = createIdentityResolutionService({ repositories });
  const subject = 'mju-chain-revoked';
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: userUid,
    emailSnapshot: 'user@example.test',
    source: 'operator_review',
  });
  await identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
  await identity.revoke(candidate.id, { revokedBy: 'reviewer@example.test' });
  const chain = createSsoIdentityChainService({
    config: baseConfig({ sso: { subjectContractConfirmed: true } }),
    repositories,
  });
  await assert.rejects(
    () => chain.issueSessionFromVerifiedInput({ confirmedSubject: subject }),
    (err) => err.status === 403 && err.code === 'IDENTITY_NOT_APPROVED',
  );
});

test('disabled employee is denied at session issuance', async () => {
  const inactiveUid = '44444444-4444-4444-4444-444444444444';
  const repositories = createFixtureRepositories();
  repositories.employees.rows.push({
    employeeUid: inactiveUid,
    employeeId: 'E-INACTIVE',
    firstNameTh: 'ไม่ใช้',
    lastNameTh: 'งาน',
    email: 'inactive@example.test',
    passwordHash: 'x',
    department: 'ภาควิชา',
    position: 'เจ้าหน้าที่',
    employeeType: 'department',
    status: 'inactive',
    role: 'user',
    lockedUntil: null,
  });
  const identity = createIdentityResolutionService({ repositories });
  const subject = 'mju-chain-inactive';
  const candidate = await identity.createCandidate({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: subject,
    employeeUid: inactiveUid,
    emailSnapshot: 'inactive@example.test',
    source: 'operator_review',
  });
  await identity.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
  const chain = createSsoIdentityChainService({
    config: baseConfig({ sso: { subjectContractConfirmed: true } }),
    repositories,
  });
  await assert.rejects(
    () => chain.issueSessionFromVerifiedInput({ confirmedSubject: subject }),
    (err) => err.status === 403 && err.code === 'SSO_USER_DISABLED',
  );
});
