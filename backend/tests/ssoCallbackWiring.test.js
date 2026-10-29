const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const config = require('../src/config');
const { extractVerifiedSubject } = require('../src/services/sso/mjuSubjectAdapter');

test('default config keeps SSO and subject contract gates off', () => {
  assert.equal(config.sso.enabled, false);
  assert.equal(config.sso.subjectContractConfirmed, false);
});

test('the live callback goes through the approved-link identity chain', () => {
  const src = fs.readFileSync(require.resolve('../src/services/ssoService.js'), 'utf8');
  // Replaces the earlier assertion that the chain was *not* wired: that was the gap.
  assert.match(src, /ssoIdentityChainService/);
  assert.match(src, /issueSessionFromVerifiedInput/);
  // The e-mail mapping may only be reachable for the mock provider (a test double).
  assert.match(src, /Mock provider only/);
});

test('identity chain is isolated in ssoIdentityChainService', () => {
  const src = fs.readFileSync(require.resolve('../src/services/ssoIdentityChainService.js'), 'utf8');
  assert.match(src, /extractVerifiedSubject/);
  assert.match(src, /createIdentityResolutionService/);
});

test('typical portal callback query stays unknown until subject contract is confirmed', () => {
  const out = extractVerifiedSubject({
    query: { ac: '0123456789abcdef0123456789abcdef' },
    subjectContractConfirmed: false,
  });
  assert.equal(out.status, 'unknown');
  assert.equal(out.subject, null);
});

test('subject contract flag alone does not verify ac as subject', () => {
  const ac = '0123456789abcdef0123456789abcdef';
  const out = extractVerifiedSubject({
    query: { ac },
    subjectContractConfirmed: true,
    treatQueryAcAsSubject: true,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.evidence, 'callback_ac_rejected');
});
