const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

const userUid = '22222222-2222-2222-2222-222222222222';
const adminUid = '11111111-1111-1111-1111-111111111111';

function serviceWithEmployees(extraEmployees = []) {
  const repositories = createFixtureRepositories();
  if (extraEmployees.length) {
    repositories.employees.rows.push(...extraEmployees);
  }
  return createIdentityResolutionService({ repositories });
}

function candidateInput(overrides = {}) {
  return {
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 'mju-subject-user-001',
    employeeUid: userUid,
    emailSnapshot: 'user@example.test',
    confidence: 'high',
    source: 'operator_review',
    ...overrides,
  };
}

test('unique provider subject rejects duplicate link', async () => {
  const service = serviceWithEmployees();
  await service.createCandidate(candidateInput());
  await assert.rejects(
    () => service.createCandidate(candidateInput({ employeeUid: adminUid })),
    (err) => err.status === 409 && err.code === 'IDENTITY_DUPLICATE',
  );
});

test('candidate cannot authenticate', async () => {
  const service = serviceWithEmployees();
  await service.createCandidate(candidateInput());
  await assert.rejects(
    () => service.resolve(PROVIDER_MJU_SSO, 'mju-subject-user-001'),
    (err) => err.status === 403 && err.code === 'IDENTITY_NOT_APPROVED',
  );
});

test('approved link resolves employee', async () => {
  const service = serviceWithEmployees();
  const candidate = await service.createCandidate(candidateInput());
  await service.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
  const result = await service.resolve(PROVIDER_MJU_SSO, 'mju-subject-user-001');
  assert.equal(result.employee.employeeUid, userUid);
  assert.equal(result.link.status, 'approved');
});

test('revoked link is denied', async () => {
  const service = serviceWithEmployees();
  const candidate = await service.createCandidate(candidateInput({ providerSubject: 'mju-subject-revoked' }));
  await service.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
  await service.revoke(candidate.id, { revokedBy: 'reviewer@example.test' });
  await assert.rejects(
    () => service.resolve(PROVIDER_MJU_SSO, 'mju-subject-revoked'),
    (err) => err.status === 403 && err.code === 'IDENTITY_NOT_APPROVED',
  );
});

test('disabled employee is denied even with approved link', async () => {
  const inactiveUid = '44444444-4444-4444-4444-444444444444';
  const service = serviceWithEmployees([
    {
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
    },
  ]);
  const candidate = await service.createCandidate(candidateInput({
    providerSubject: 'mju-subject-inactive',
    employeeUid: inactiveUid,
    emailSnapshot: 'inactive@example.test',
  }));
  await service.approve(candidate.id, { approvedBy: 'reviewer@example.test' });
  await assert.rejects(
    () => service.resolve(PROVIDER_MJU_SSO, 'mju-subject-inactive'),
    (err) => err.status === 403 && err.code === 'SSO_USER_DISABLED',
  );
});

test('ambiguous enrichment cannot be approved', async () => {
  const service = serviceWithEmployees();
  const candidate = await service.createCandidate(candidateInput({
    providerSubject: 'mju-subject-ambiguous',
    source: 'mju_person_enrich',
    confidence: 'ambiguous',
    enrichmentOutcome: 'ambiguous',
  }));
  await assert.rejects(
    () => service.approve(candidate.id, { approvedBy: 'reviewer@example.test' }),
    (err) => err.status === 403 && err.code === 'IDENTITY_REVIEW_REQUIRED',
  );
});

test('email mismatch does not silently relink on approve', async () => {
  const service = serviceWithEmployees();
  const candidate = await service.createCandidate(candidateInput({
    providerSubject: 'mju-subject-email-mismatch',
    emailSnapshot: 'other@example.test',
  }));
  await assert.rejects(
    () => service.approve(candidate.id, { approvedBy: 'reviewer@example.test' }),
    (err) => err.status === 409 && err.code === 'IDENTITY_EMAIL_MISMATCH',
  );
});

test('unknown subject fails closed', async () => {
  const service = serviceWithEmployees();
  await assert.rejects(
    () => service.resolve(PROVIDER_MJU_SSO, 'does-not-exist'),
    (err) => err.status === 403 && err.code === 'IDENTITY_UNKNOWN',
  );
});

test('callback ac cannot be used as provider subject', async () => {
  const service = serviceWithEmployees();
  await assert.rejects(
    () => service.createCandidate(candidateInput({ providerSubject: 'ac', usesCallbackAc: true })),
    (err) => err.status === 400,
  );
});

test('approved email mismatch fails closed at resolve time', async () => {
  const service = serviceWithEmployees();
  const candidate = await service.createCandidate(candidateInput({
    providerSubject: 'mju-subject-approved-mismatch',
    emailSnapshot: 'other@example.test',
  }));
  await service.approve(candidate.id, {
    approvedBy: 'reviewer@example.test',
    acknowledgeEmailMismatch: true,
  });
  await assert.rejects(
    () => service.resolve(PROVIDER_MJU_SSO, 'mju-subject-approved-mismatch'),
    (err) => err.status === 403 && err.code === 'IDENTITY_EMAIL_MISMATCH',
  );
});
