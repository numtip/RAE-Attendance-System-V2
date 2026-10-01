const assert = require('node:assert/strict');
const test = require('node:test');
const { extractVerifiedSubject } = require('../src/services/sso/mjuSubjectAdapter');
const { PROVIDER_MJU_SSO } = require('../src/domain/identityLink');

test('unknown callback contract returns unknown', () => {
  const out = extractVerifiedSubject({ query: { ac: 'a'.repeat(32) } });
  assert.equal(out.status, 'unknown');
  assert.equal(out.provider, PROVIDER_MJU_SSO);
  assert.equal(out.subject, null);
  assert.equal(out.evidence, 'mju_subject_contract_unknown');
});

test('callback ac is rejected when used as subject', () => {
  const out = extractVerifiedSubject({ subject: 'ac', usesCallbackAc: true });
  assert.equal(out.status, 'invalid');
  assert.equal(out.evidence, 'callback_ac_rejected');
});

test('email-only input is rejected as permanent subject', () => {
  const out = extractVerifiedSubject({
    subjectContractConfirmed: true,
    emailOnly: true,
    confirmedSubject: 'user@example.test',
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.evidence, 'email_only_rejected');
});

test('email-only oauth profile is rejected', () => {
  const out = extractVerifiedSubject({
    subjectContractConfirmed: true,
    profile: { email: 'user@example.test' },
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.evidence, 'email_only_profile_rejected');
});

test('verified subject when contract flag and opaque claim are present', () => {
  const out = extractVerifiedSubject({
    subjectContractConfirmed: true,
    confirmedSubject: 'mju-opaque-subject-77',
    subjectType: 'opaque',
  });
  assert.equal(out.status, 'verified');
  assert.equal(out.subject, 'mju-opaque-subject-77');
  assert.equal(out.subjectType, 'opaque');
});
