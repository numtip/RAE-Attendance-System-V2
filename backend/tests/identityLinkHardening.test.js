/**
 * Identity-link hardening (ID-6 / ID-7). Negative and regression tests.
 *
 * What this file proves, and why it is written the way it is:
 *
 *  1. The e-mail / callback-`ac` prohibition is enforced at the LINK LAYER, not only in the SSO adapter.
 *     Every test here calls the SERVICE DIRECTLY, bypassing the adapter completely - which is exactly the
 *     route a future enrichment ingestion path, a script or a test helper would take.
 *  2. Provenance cannot be asserted into existence: an unknown `source` is refused, which is what makes the
 *     ambiguity guard unbypassable (the guard is scoped to known enrichment sources).
 *  3. Approval cannot be reached without declared evidence on the SSO path, and a candidate/rejected/revoked
 *     link can never resolve.
 *  4. SSO resolves the employee's OWN stored role; a subject cannot escalate privileges.
 *
 * All fixtures are synthetic. No national ID is used anywhere in this file (identity links carry provider
 * subjects, not citizen IDs), so there is nothing here that could resemble a real identifier.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const {
  PROVIDER_MJU_SSO,
  IDENTITY_LINK_SOURCES,
  SUBJECT_REJECTION,
  MAX_SUBJECT_LENGTH,
  rejectionCodeForProviderSubject,
  isKnownSource,
  enrichmentBlocksApproval,
} = require('../src/domain/identityLink');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

function service() {
  return createIdentityResolutionService({ repositories: createFixtureRepositories() });
}

function candidateInput(overrides = {}) {
  return {
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 'subject-hardening-001',
    employeeUid: USER_UID,
    // An e-mail SNAPSHOT is legitimate evidence; an e-mail SUBJECT is not. The distinction matters and is
    // asserted explicitly below.
    emailSnapshot: 'user@example.test',
    confidence: 'high',
    source: 'operator_review',
    ...overrides,
  };
}

async function rejectionOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return { status: error.status, code: error.code };
  }
}

// ---------------------------------------------------------------------------------------------
// ID-6: the subject guard, called DIRECTLY on the service (no adapter in the path)
// ---------------------------------------------------------------------------------------------

test('ID-6: createCandidate refuses an e-mail-shaped subject even when the adapter is bypassed', async () => {
  const svc = service();
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({
    providerSubject: 'someone@example.test',
  })));
  assert.deepEqual(rejection, { status: 400, code: 'IDENTITY_SUBJECT_IS_EMAIL_LIKE' });
});

test('ID-6: createCandidate refuses the callback ac marker as a subject', async () => {
  const svc = service();
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ providerSubject: 'ac' })));
  assert.deepEqual(rejection, { status: 400, code: 'IDENTITY_SUBJECT_IS_CALLBACK_AC' });
});

test('ID-6: whitespace cannot smuggle a forbidden subject past the guard', async () => {
  const svc = service();
  // These would all pass a naive `=== 'ac'` / unanchored e-mail check.
  for (const subject of ['  ac  ', '\tac\n', '  a@b.co  ', ' x@y.zz ']) {
    const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ providerSubject: subject })));
    assert.equal(rejection?.status, 400, `subject ${JSON.stringify(subject)} must be refused`);
    assert.ok(
      rejection.code === 'IDENTITY_SUBJECT_IS_CALLBACK_AC' || rejection.code === 'IDENTITY_SUBJECT_IS_EMAIL_LIKE',
      `unexpected code for ${JSON.stringify(subject)}: ${rejection.code}`,
    );
  }
});

test('ID-6: the usesCallbackAc flag is honoured independently of the subject text', async () => {
  const svc = service();
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({
    providerSubject: 'looks-fine-but-is-ac', usesCallbackAc: true,
  })));
  assert.deepEqual(rejection, { status: 400, code: 'IDENTITY_SUBJECT_IS_CALLBACK_AC' });
});

test('ID-6: empty, malformed and oversized subjects are refused with distinct codes', async () => {
  const svc = service();
  const cases = [
    ['', 'VALIDATION_ERROR'],
    ['   ', 'VALIDATION_ERROR'],
    // `NaN` is falsy, so the "required" check catches it before the malformed check - either way it is
    // refused, and the test records which code actually fires rather than asserting a preference.
    [Number.NaN, 'VALIDATION_ERROR'],
    [{}, 'IDENTITY_SUBJECT_MALFORMED'],
    [[], 'IDENTITY_SUBJECT_MALFORMED'],
    [true, 'IDENTITY_SUBJECT_MALFORMED'],
    // Infinity is truthy, so it reaches the malformed check.
    [Number.POSITIVE_INFINITY, 'IDENTITY_SUBJECT_MALFORMED'],
    ['x'.repeat(MAX_SUBJECT_LENGTH + 1), 'IDENTITY_SUBJECT_TOO_LONG'],
  ];
  for (const [subject, expectedCode] of cases) {
    const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ providerSubject: subject })));
    assert.equal(rejection?.status, 400, `subject ${String(subject).slice(0, 20)} must be refused`);
    assert.equal(rejection.code, expectedCode, `subject ${String(subject).slice(0, 20)}`);
  }
});

test('ID-6: the guard is not a blanket refusal - a real opaque subject still works', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({ providerSubject: 'opaque-7f3a91' }));
  assert.equal(link.status, 'candidate');
  assert.equal(link.providerSubject, 'opaque-7f3a91');
});

test('ID-6: a numeric subject is accepted, because some providers issue numeric subjects', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({ providerSubject: 1234567 }));
  assert.equal(link.status, 'candidate');
});

test('ID-6: an e-mail SNAPSHOT is still allowed - only the SUBJECT is restricted', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({
    providerSubject: 'opaque-subject-1',
    emailSnapshot: 'user@example.test',
  }));
  assert.equal(link.emailSnapshot, 'user@example.test');
  assert.equal(link.providerSubject, 'opaque-subject-1');
});

test('ID-6: the domain guard is the single decision point (unit level)', () => {
  assert.equal(rejectionCodeForProviderSubject('opaque'), null);
  assert.equal(rejectionCodeForProviderSubject('ac'), SUBJECT_REJECTION.CALLBACK_AC);
  assert.equal(rejectionCodeForProviderSubject('AC'), SUBJECT_REJECTION.CALLBACK_AC);
  assert.equal(rejectionCodeForProviderSubject('a@b.co'), SUBJECT_REJECTION.EMAIL_LIKE);
  assert.equal(rejectionCodeForProviderSubject(''), SUBJECT_REJECTION.REQUIRED);
  assert.equal(rejectionCodeForProviderSubject(undefined), SUBJECT_REJECTION.MALFORMED);
  assert.equal(rejectionCodeForProviderSubject(null), SUBJECT_REJECTION.MALFORMED);
  assert.equal(rejectionCodeForProviderSubject({}), SUBJECT_REJECTION.MALFORMED);
  assert.equal(
    rejectionCodeForProviderSubject('y'.repeat(MAX_SUBJECT_LENGTH + 1)),
    SUBJECT_REJECTION.TOO_LONG,
  );
  assert.equal(rejectionCodeForProviderSubject('y'.repeat(MAX_SUBJECT_LENGTH)), null);
});

// ---------------------------------------------------------------------------------------------
// ID-6: the SAME guard on the alternate path (SSO first-login link)
// ---------------------------------------------------------------------------------------------

test('ID-6: linkProviderSubjectFromSsoLogin applies the same subject guard', async () => {
  const svc = service();
  for (const [subject, code] of [
    ['someone@example.test', 'IDENTITY_SUBJECT_IS_EMAIL_LIKE'],
    ['ac', 'IDENTITY_SUBJECT_IS_CALLBACK_AC'],
    [{}, 'IDENTITY_SUBJECT_MALFORMED'],
  ]) {
    const rejection = await rejectionOf(() => svc.linkProviderSubjectFromSsoLogin({
      providerKey: PROVIDER_MJU_SSO,
      providerSubject: subject,
      employeeUid: USER_UID,
      evidence: { nationalIdLookupMatched: true },
    }));
    assert.equal(rejection?.code, code, `subject ${String(subject).slice(0, 20)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// ID-7: the source allowlist
// ---------------------------------------------------------------------------------------------

test('ID-7: an unknown source is refused at BOTH creation paths', async () => {
  const svc = service();
  for (const source of ['made_up_source', 'MJU_PERSON_ENRICH', 'operator_review ', '']) {
    const viaCandidate = await rejectionOf(() => svc.createCandidate(candidateInput({ source })));
    assert.equal(viaCandidate?.code, source === '' ? 'VALIDATION_ERROR' : 'IDENTITY_SOURCE_UNKNOWN',
      `candidate path, source ${JSON.stringify(source)}`);

    const viaSso = await rejectionOf(() => svc.linkProviderSubjectFromSsoLogin({
      providerKey: PROVIDER_MJU_SSO,
      providerSubject: 'subject-src-1',
      employeeUid: USER_UID,
      source,
      evidence: { nationalIdLookupMatched: true },
    }));
    assert.equal(viaSso?.code, 'IDENTITY_SOURCE_UNKNOWN', `sso path, source ${JSON.stringify(source)}`);
  }
});

test('ID-7: every allowed source is accepted, and a case-mismatch is NOT (exact allowlist)', async () => {
  for (const source of IDENTITY_LINK_SOURCES) {
    const svc = service();
    const link = await svc.createCandidate(candidateInput({ source, providerSubject: `s-${source}` }));
    assert.equal(link.source, source, `source ${source} must be stored verbatim`);
  }
  const svc = service();
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ source: 'Operator_Review' })));
  assert.equal(rejection?.code, 'IDENTITY_SOURCE_UNKNOWN', 'the allowlist is case-sensitive by design');
});

test('ID-7: THE BYPASS THIS CLOSES - an invented source can no longer escape the ambiguity guard', async () => {
  const svc = service();

  // Before the allowlist, a caller could pass an arbitrary source string and create a link whose
  // `ambiguous` outcome would NOT be blocked at approval (`enrichmentBlocksApproval` is scoped to known
  // enrichment sources). That is now impossible: the link cannot be created at all.
  const invented = await rejectionOf(() => svc.createCandidate(candidateInput({
    source: 'not_a_real_enrichment_source',
    confidence: 'ambiguous',
    enrichmentOutcome: 'ambiguous',
  })));
  assert.equal(invented?.code, 'IDENTITY_SOURCE_UNKNOWN');

  // And the legitimate path is still blocked, so the guard was not weakened while closing the hole.
  const legit = await svc.createCandidate(candidateInput({
    source: 'mju_person_enrich',
    providerSubject: 's-enrich-1',
    confidence: 'ambiguous',
    enrichmentOutcome: 'ambiguous',
  }));
  const approval = await rejectionOf(() => svc.approve(legit.id, { approvedBy: 'reviewer@example.test' }));
  assert.deepEqual(approval, { status: 403, code: 'IDENTITY_REVIEW_REQUIRED' });
});

test('ID-7: the guarded allowlist is FROZEN - a runtime mutation cannot widen it', () => {
  assert.ok(Object.isFrozen(IDENTITY_LINK_SOURCES), 'the allowlist must be frozen');
  assert.throws(() => { IDENTITY_LINK_SOURCES.push('sneaky_source'); }, TypeError);
  assert.equal(isKnownSource('sneaky_source'), false);
  assert.equal(IDENTITY_LINK_SOURCES.length, new Set(IDENTITY_LINK_SOURCES).size, 'no duplicates');
});

test('ID-7: the ambiguity guard is SOURCE-SCOPED, and that is why create-time rejection is the control', async () => {
  // Documented boundary, asserted rather than assumed: `enrichmentBlocksApproval` returns false for a source
  // that is not a known enrichment source. A row that somehow predates the allowlist (a legacy or imported
  // row written directly to the store) would therefore not be blocked by that guard. The control against it
  // is that the row cannot be CREATED through the service.
  const repositories = createFixtureRepositories();
  const svc = createIdentityResolutionService({ repositories });
  const provider = await repositories.identityLinks.findProviderByKey(PROVIDER_MJU_SSO);
  const legacy = await repositories.identityLinks.insertLink({
    employeeUid: USER_UID,
    providerId: provider.id,
    providerSubject: 'legacy-subject-1',
    subjectType: 'opaque',
    status: 'candidate',
    confidence: 'ambiguous',
    source: 'a_source_that_predates_the_allowlist',
    enrichmentOutcome: 'ambiguous',
  });

  assert.equal(
    enrichmentBlocksApproval(legacy),
    false,
    'the enrichment guard is source-scoped - which is exactly why the allowlist exists at creation',
  );

  // The same link CANNOT be created through the service, which is the actual control.
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({
    source: 'a_source_that_predates_the_allowlist',
  })));
  assert.equal(rejection?.code, 'IDENTITY_SOURCE_UNKNOWN');
});

// ---------------------------------------------------------------------------------------------
// Approval cannot be reached without declared evidence
// ---------------------------------------------------------------------------------------------

test('ID-7/req4: an SSO link is refused when no matched national-ID lookup is declared', async () => {
  const svc = service();
  for (const evidence of [undefined, {}, { nationalIdLookupMatched: false }, { other: true }]) {
    const rejection = await rejectionOf(() => svc.linkProviderSubjectFromSsoLogin({
      providerKey: PROVIDER_MJU_SSO,
      providerSubject: 'subject-evidence-1',
      employeeUid: USER_UID,
      evidence,
    }));
    assert.deepEqual(rejection, { status: 403, code: 'IDENTITY_EVIDENCE_REQUIRED' }, JSON.stringify(evidence));
  }
});

test('ID-7/req4: with declared evidence the link is approved, and its provenance is recorded', async () => {
  const svc = service();
  const link = await svc.linkProviderSubjectFromSsoLogin({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 'subject-evidence-ok',
    employeeUid: USER_UID,
    subjectType: 'candidate:humanID',
    source: 'mju_token_candidate_subject',
    confidence: 'medium',
    evidence: { nationalIdLookupMatched: true },
  });
  assert.equal(link.status, 'approved');
  // Traceability is the point: who approved it, and on what class of evidence.
  assert.equal(link.approvedBy, 'system:sso');
  assert.equal(link.source, 'mju_token_candidate_subject');
  assert.equal(link.subjectType, 'candidate:humanID');
});

// ---------------------------------------------------------------------------------------------
// Fail-closed resolution and no privilege escalation
// ---------------------------------------------------------------------------------------------

test('fail closed: only an approved link resolves; candidate, rejected and revoked never do', async () => {
  const statuses = [
    ['candidate', async (svc) => svc.createCandidate(candidateInput({ providerSubject: 's-candidate' }))],
    ['rejected', async (svc) => {
      const link = await svc.createCandidate(candidateInput({ providerSubject: 's-rejected' }));
      return svc.reject(link.id, { rejectedBy: 'reviewer@example.test' });
    }],
    ['revoked', async (svc) => {
      const link = await svc.createCandidate(candidateInput({ providerSubject: 's-revoked' }));
      const approved = await svc.approve(link.id, { approvedBy: 'reviewer@example.test' });
      return svc.revoke(approved.id, { revokedBy: 'reviewer@example.test' });
    }],
  ];

  for (const [label, prepare] of statuses) {
    const svc = service();
    await prepare(svc);
    const rejection = await rejectionOf(() => svc.resolve(PROVIDER_MJU_SSO, `s-${label}`));
    assert.deepEqual(rejection, { status: 403, code: 'IDENTITY_NOT_APPROVED' }, `${label} must not authenticate`);
  }
});

test('fail closed: an unknown subject and an unknown provider never resolve', async () => {
  const svc = service();
  assert.deepEqual(
    await rejectionOf(() => svc.resolve(PROVIDER_MJU_SSO, 'never-seen')),
    { status: 403, code: 'IDENTITY_UNKNOWN' },
  );
  assert.deepEqual(
    await rejectionOf(() => svc.resolve('not_a_provider', 'x')),
    { status: 403, code: 'IDENTITY_PROVIDER_DISABLED' },
  );
});

test('req4: resolving returns the employee OWN role - an SSO subject cannot escalate privileges', async () => {
  const svc = service();
  // An operator-approved link for the ORDINARY user, whose stored role is 'user'.
  const link = await svc.createCandidate(candidateInput({
    providerSubject: 's-role-check',
    employeeUid: USER_UID,
  }));
  await svc.approve(link.id, { approvedBy: 'reviewer@example.test' });

  const resolved = await svc.resolve(PROVIDER_MJU_SSO, 's-role-check');
  assert.equal(resolved.employee.employeeUid, USER_UID);
  assert.equal(resolved.employee.role, 'user', 'the role comes from the employee row, not from the subject');

  // And an admin's OWN link still resolves as admin, so the assertion above is not vacuous.
  const adminLink = await svc.createCandidate(candidateInput({
    providerSubject: 's-role-check-admin',
    employeeUid: ADMIN_UID,
    // The admin's own address, so the approval is not blocked by the email-evidence check.
    emailSnapshot: 'admin@example.test',
  }));
  await svc.approve(adminLink.id, { approvedBy: 'reviewer@example.test' });
  const adminResolved = await svc.resolve(PROVIDER_MJU_SSO, 's-role-check-admin');
  assert.equal(adminResolved.employee.role, 'admin');
});

// ---------------------------------------------------------------------------------------------
// Duplicate candidates
// ---------------------------------------------------------------------------------------------

test('duplicates: the same provider subject cannot create two links', async () => {
  const svc = service();
  await svc.createCandidate(candidateInput());
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ employeeUid: ADMIN_UID })));
  assert.deepEqual(rejection, { status: 409, code: 'IDENTITY_DUPLICATE' });
});

test('duplicates: an employee with an approved link cannot also get a candidate for another subject', async () => {
  const svc = service();
  const first = await svc.createCandidate(candidateInput({ providerSubject: 's-first' }));
  await svc.approve(first.id, { approvedBy: 'reviewer@example.test' });
  const rejection = await rejectionOf(() => svc.createCandidate(candidateInput({ providerSubject: 's-second' })));
  assert.deepEqual(rejection, { status: 409, code: 'IDENTITY_CONFLICT' });
});

test('duplicates: the SSO path refuses to move a subject that already belongs to another employee', async () => {
  const svc = service();
  await svc.createCandidate(candidateInput({ providerSubject: 's-owned' }));
  const rejection = await rejectionOf(() => svc.linkProviderSubjectFromSsoLogin({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 's-owned',
    employeeUid: ADMIN_UID,
    evidence: { nationalIdLookupMatched: true },
  }));
  assert.deepEqual(rejection, { status: 409, code: 'IDENTITY_SUBJECT_CONFLICT' });
});

test('duplicates: the SSO path never PROMOTES an existing candidate (only a reviewer may)', async () => {
  const svc = service();
  await svc.createCandidate(candidateInput({ providerSubject: 's-existing-candidate' }));
  const rejection = await rejectionOf(() => svc.linkProviderSubjectFromSsoLogin({
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 's-existing-candidate',
    employeeUid: USER_UID,
    evidence: { nationalIdLookupMatched: true },
  }));
  assert.deepEqual(rejection, { status: 403, code: 'IDENTITY_NOT_APPROVED' });
});

test('no rejected or non-existent link can be approved or revoked', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({ providerSubject: 's-state-1' }));
  await svc.reject(link.id, { rejectedBy: 'reviewer@example.test' });

  assert.equal((await rejectionOf(() => svc.approve(link.id, { approvedBy: 'r@example.test' })))?.code,
    'IDENTITY_INVALID_STATE');
  assert.equal((await rejectionOf(() => svc.revoke(link.id, { revokedBy: 'r@example.test' })))?.code,
    'IDENTITY_INVALID_STATE');
  assert.equal((await rejectionOf(() => svc.approve(99999, { approvedBy: 'r@example.test' })))?.status, 404);
});

test('approval requires an attributable reviewer', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({ providerSubject: 's-attrib' }));
  const rejection = await rejectionOf(() => svc.approve(link.id, {}));
  assert.deepEqual(rejection, { status: 400, code: 'VALIDATION_ERROR' });
});
