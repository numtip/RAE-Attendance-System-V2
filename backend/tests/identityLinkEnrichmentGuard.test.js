/**
 * ID-7b — the enrichment-outcome guard is an ALLOWLIST with an explicit absence check.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The guard used to be a blocklist: it refused approval only when the stored outcome was one of
 * `BLOCKED_ENRICHMENT_OUTCOMES`. Two holes followed from that shape:
 *
 *   1. A new failure status would silently become approvable, because it simply was not on the list.
 *   2. An ABSENT outcome was treated as "nothing to block". That hole was live: `employee_identity_links`
 *      has never had an `enrichment_outcome` column, so on MariaDB the value read back is always `null`,
 *      and the guard never fired for any row in production - while every fixture test passed, because the
 *      fixture twin does persist the field.
 *
 * The guard now refuses an absent outcome and an unrecognised outcome, so "we cannot establish that this
 * was a clean single-person match" fails closed.
 *
 * IMPORTANT SCOPE NOTE: these assertions run against the FIXTURE repository, which CAN persist the outcome.
 * They are therefore necessary but NOT sufficient - a green run here previously coexisted with an inert
 * control in production. The MariaDB-backed proof lives in
 * `identityLinkEnrichment.mariadb.test.js`, which runs in the `backend-mariadb` CI job.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const {
  PROVIDER_MJU_SSO,
  ENRICHMENT_SOURCES,
  BLOCKED_ENRICHMENT_OUTCOMES,
  ALLOWED_ENRICHMENT_OUTCOMES,
  enrichmentBlocksApproval,
  isEnrichmentSource,
} = require('../src/domain/identityLink');

const USER_UID = '22222222-2222-2222-2222-222222222222';

function service() {
  return createIdentityResolutionService({ repositories: createFixtureRepositories() });
}

function candidateInput(overrides = {}) {
  return {
    providerKey: PROVIDER_MJU_SSO,
    providerSubject: 'id7b-subject-1',
    employeeUid: USER_UID,
    confidence: 'high',
    source: 'mju_person_enrich',
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
// The allowlist is a closed set, and it is the ONLY approvable outcome
// ---------------------------------------------------------------------------------------------

test('ID-7b: the allowlist is frozen, small and disjoint from the blocked list', () => {
  assert.ok(Object.isFrozen(ALLOWED_ENRICHMENT_OUTCOMES), 'the allowlist must be frozen');
  assert.equal(ALLOWED_ENRICHMENT_OUTCOMES.length, new Set(ALLOWED_ENRICHMENT_OUTCOMES).size, 'no duplicates');
  assert.deepEqual([...ALLOWED_ENRICHMENT_OUTCOMES], ['found'], 'only a clean single-person match is approvable');

  // Allowed and blocked must not overlap: an outcome cannot be both.
  const overlap = ALLOWED_ENRICHMENT_OUTCOMES.filter((o) => BLOCKED_ENRICHMENT_OUTCOMES.includes(o));
  assert.deepEqual(overlap, [], 'an outcome cannot be both allowed and blocked');
});

test('ID-7b: every outcome the enrichment tool can emit is classified as allowed or blocked', () => {
  // The tool's own status vocabulary (docs/IDENTITY_INTEGRATION_AUDIT.md §1/§2): found, not_found, ambiguous,
  // api_error, timeout. `fallback` and `firstname_only` are additional internal outcomes. Each must be
  // deliberately classified, so a future sixth status cannot default into "approvable by omission".
  const EMITTED = ['found', 'not_found', 'ambiguous', 'api_error', 'timeout', 'fallback', 'firstname_only'];
  for (const outcome of EMITTED) {
    const classified = ALLOWED_ENRICHMENT_OUTCOMES.includes(outcome) || BLOCKED_ENRICHMENT_OUTCOMES.includes(outcome);
    assert.equal(classified, true, `the enrichment outcome "${outcome}" is neither allowed nor blocked`);
  }
});

// ---------------------------------------------------------------------------------------------
// The guard itself, at the domain level
// ---------------------------------------------------------------------------------------------

test('ID-7b: an ABSENT outcome blocks approval for an enrichment source', () => {
  for (const source of ENRICHMENT_SOURCES) {
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: null, confidence: 'high' }),
      true,
      `${source}: a missing outcome must fail closed (this is the ID-7b fix)`,
    );
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: undefined, confidence: 'high' }),
      true,
      `${source}: undefined must behave like null`,
    );
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: '', confidence: 'high' }),
      true,
      `${source}: an empty string is not an outcome`,
    );
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: '   ', confidence: 'high' }),
      true,
      `${source}: whitespace is not an outcome`,
    );
  }
});

test('ID-7b: an UNRECOGNISED outcome blocks approval (the blocklist hole)', () => {
  for (const source of ENRICHMENT_SOURCES) {
    // Note: whitespace variants of a VALID outcome are NOT in this list. The guard deliberately trims
    // (a guard should be generous about formatting while validation is strict), and the trim behaviour is
    // asserted separately below. Putting `'found '` here would contradict that and was a bug in the first
    // draft of this test.
    for (const outcome of ['some_new_status', 'FOUND', 'Found', 'partial', 'foundx', 'found,ambiguous']) {
      assert.equal(
        enrichmentBlocksApproval({ source, enrichmentOutcome: outcome, confidence: 'high' }),
        true,
        `${source}: unknown outcome ${JSON.stringify(outcome)} must not be approvable`,
      );
    }
  }
  // Case sensitivity is deliberate: the tool emits lowercase, so an upper-case variant is not trusted.
  assert.equal(enrichmentBlocksApproval({ source: 'mju_person_enrich', enrichmentOutcome: 'FOUND' }), true);
  // The exact lowercase value IS approvable, so the guard is not a blanket refusal.
  assert.equal(enrichmentBlocksApproval({ source: 'mju_person_enrich', enrichmentOutcome: 'found' }), false);
  // And a whitespace-padded valid value is approvable, because the guard trims.
  assert.equal(enrichmentBlocksApproval({ source: 'mju_person_enrich', enrichmentOutcome: ' found ' }), false);
});

test('ID-7b: every blocked outcome still blocks, and confidence still blocks independently', () => {
  for (const source of ENRICHMENT_SOURCES) {
    for (const outcome of BLOCKED_ENRICHMENT_OUTCOMES) {
      assert.equal(
        enrichmentBlocksApproval({ source, enrichmentOutcome: outcome, confidence: 'high' }),
        true,
        `${source}/${outcome} must block`,
      );
    }
    // A contradictory pair: the outcome says the match resolved, the confidence says it did not.
    for (const confidence of ['ambiguous', 'low']) {
      assert.equal(
        enrichmentBlocksApproval({ source, enrichmentOutcome: 'found', confidence }),
        true,
        `${source}: a "found"/"${confidence}" pair is contradictory evidence and must be reviewed`,
      );
    }
    // Whitespace around a valid outcome is tolerated (the guard trims); this is the lenient direction.
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: ' found ', confidence: 'high' }),
      false,
      `${source}: the guard trims, because a guard should be generous about formatting`,
    );
  }
});

test('ID-7b: legitimate NON-enrichment flows are preserved (the guard is not a blanket refusal)', () => {
  // An operator review is human evidence: a human looked at the match and approved it. It carries no
  // enrichment outcome, and requiring one would break the only path by which a link can be approved today.
  for (const source of ['operator_review', 'mju_token_candidate_subject', 'sso_national_id_resolution']) {
    assert.equal(isEnrichmentSource(source), false, `${source} must not be treated as machine evidence`);
    assert.equal(
      enrichmentBlocksApproval({ source, enrichmentOutcome: null, confidence: 'high' }),
      false,
      `${source}: must remain approvable with no outcome`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Through the service, on the real approve() path
// ---------------------------------------------------------------------------------------------

test('ID-7b: the service refuses to approve an enrichment link with a missing outcome', async () => {
  const svc = service();
  // The fixture twin persists what it is given, so this creates the exact row shape MariaDB produces for
  // EVERY enrichment link: source is an enrichment source, outcome is null.
  const link = await svc.createCandidate(candidateInput({
    source: 'mju_person_enrich',
    providerSubject: 'id7b-missing',
    enrichmentOutcome: undefined,
  }));
  assert.equal(link.enrichmentOutcome, null, 'the fixture stores null when no outcome is supplied');

  const rejection = await rejectionOf(() => svc.approve(link.id, { approvedBy: 'reviewer@example.test' }));
  assert.deepEqual(rejection, { status: 403, code: 'IDENTITY_REVIEW_REQUIRED' });
});

test('ID-7b: the service refuses to approve an unrecognised enrichment outcome', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({
    source: 'mju_person_enrich',
    providerSubject: 'id7b-unknown',
    enrichmentOutcome: 'a_status_nobody_classified',
  }));
  const rejection = await rejectionOf(() => svc.approve(link.id, { approvedBy: 'reviewer@example.test' }));
  assert.deepEqual(rejection, { status: 403, code: 'IDENTITY_REVIEW_REQUIRED' });
});

test('ID-7b: a clean enrichment link IS approvable, so the guard did not become a wall', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({
    source: 'mju_person_enrich',
    providerSubject: 'id7b-clean',
    enrichmentOutcome: 'found',
    confidence: 'high',
  }));
  const approved = await svc.approve(link.id, { approvedBy: 'reviewer@example.test' });
  assert.equal(approved.status, 'approved', 'a clean single-person match must remain approvable');
  assert.equal(approved.approvedBy, 'reviewer@example.test');
});

test('ID-7b: an operator link with no outcome is still approvable through the service', async () => {
  const svc = service();
  const link = await svc.createCandidate(candidateInput({
    source: 'operator_review',
    providerSubject: 'id7b-operator',
    emailSnapshot: 'user@example.test',
  }));
  const approved = await svc.approve(link.id, { approvedBy: 'reviewer@example.test' });
  assert.equal(approved.status, 'approved', 'the human-evidence path must keep working');
});
