/**
 * ID-7b — the enrichment-outcome guard must FAIL CLOSED on the real store, not only on fixtures.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `identityLinkHardening.test.js`
 * ------------------------------------------------------------------
 * That file tests the guard against the FIXTURE repository, where `enrichmentOutcome` IS persisted. Every
 * assertion in it passed while the control was inert in production, because `employee_identity_links` has
 * never had an `enrichment_outcome` column: the MariaDB repository hardcodes `enrichmentOutcome: null`.
 *
 * So a fixture test cannot prove this control works. These tests exercise the REAL MariaDB repository and
 * will only run where a database is present (the `backend-mariadb` CI job, or a local MariaDB with
 * `RUN_MARIADB_TESTS=1`). The suite is skipped elsewhere and says so, rather than reporting a false pass.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 *  1. The divergence is real and reproducible: an enrichment link written through the MariaDB repository
 *     reads back with `enrichmentOutcome === null`, because the column does not exist.
 *  2. Given that, the FAIL-CLOSED guard refuses approval. This is the actual remediation: the control no
 *     longer depends on a field the store cannot provide.
 *  3. Legitimate NON-enrichment flows are untouched — an `operator_review` link with no outcome is still
 *     approvable, so the guard is not a blanket refusal.
 *
 * The skill is NOT an assertion that the store persists the outcome. It does not, and asserting otherwise
 * would be inventing evidence. Until migration `025` (a proposal) adds the column, the correct behaviour is
 * for enrichment links to be unapprovable, and that is what is asserted.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const {
  createIdentityLinkMariaDbRepository,
} = require('../src/repositories/mariadb/identityLinkMariaDbRepository');
const { createIdentityResolutionService } = require('../src/services/identityResolutionService');
const {
  PROVIDER_MJU_SSO,
  ALLOWED_ENRICHMENT_OUTCOMES,
  enrichmentBlocksApproval,
} = require('../src/domain/identityLink');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const SUBJECT = 'id7b-mariadb-subject-1';
const SUBJECT_OPERATOR = 'id7b-mariadb-operator-1';

test('ID-7b (MariaDB): the store cannot persist an enrichment outcome, so approval FAILS CLOSED', {
  skip: !shouldRunMariaDbIntegration(),
}, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const links = createIdentityLinkMariaDbRepository(pool);
  const provider = await links.findProviderByKey(PROVIDER_MJU_SSO);
  assert.ok(provider, 'the mju_sso provider must be seeded for this test to be meaningful');

  t.after(async () => {
    await pool.query(
      'DELETE FROM employee_identity_links WHERE provider_subject IN (?, ?)',
      [SUBJECT, SUBJECT_OPERATOR],
    );
    await closePool();
  });

  // --- 1. The divergence, demonstrated on the real store -------------------------------------------
  const written = await links.insertLink({
    employeeUid: '22222222-2222-2222-2222-222222222222',
    providerId: provider.id,
    providerSubject: SUBJECT,
    subjectType: 'opaque',
    status: 'candidate',
    confidence: 'high',
    source: 'mju_person_enrich',
    // Deliberately claiming the CLEAN outcome, to prove the claim cannot survive the round trip.
    enrichmentOutcome: ALLOWED_ENRICHMENT_OUTCOMES[0],
  });

  // This assertion IS the finding: the value we wrote is not the value we read.
  assert.equal(
    written.enrichmentOutcome,
    null,
    'the MariaDB repository cannot persist enrichment_outcome (no such column); if this now returns '
    + '"found", migration 025 has landed and this test must be revisited to assert the ALLOWLIST behaviour '
    + 'instead of the fail-closed-on-absence behaviour',
  );

  // --- 2. Therefore approval must be refused, on the real row ------------------------------------
  assert.equal(
    enrichmentBlocksApproval(written),
    true,
    'an enrichment link whose outcome the store cannot provide must NOT be approvable',
  );

  const service = createIdentityResolutionService({ repositories: {
    identityLinks: links,
    employees: { async findByUid() { return { employeeUid: '22222222-2222-2222-2222-222222222222', email: 'user@example.test', status: 'active' }; } },
    authorization: { async grantsFor() { return []; }, async uidsInOrgUnits() { return []; } },
  } });

  await assert.rejects(
    () => service.approve(written.id, { approvedBy: 'reviewer@example.test' }),
    (error) => error.status === 403 && error.code === 'IDENTITY_REVIEW_REQUIRED',
    'the service must refuse approval with IDENTITY_REVIEW_REQUIRED, not merely a domain predicate',
  );

  // --- 3. A legitimate non-enrichment flow still works -------------------------------------------
  const operatorLink = await links.insertLink({
    employeeUid: '22222222-2222-2222-2222-222222222222',
    providerId: provider.id,
    providerSubject: SUBJECT_OPERATOR,
    subjectType: 'opaque',
    status: 'candidate',
    confidence: 'high',
    source: 'operator_review',
  });

  assert.equal(
    enrichmentBlocksApproval(operatorLink),
    false,
    'an operator-review link carries human evidence; the enrichment guard must not apply to it',
  );

  const approved = await service.approve(operatorLink.id, { approvedBy: 'reviewer@example.test' });
  assert.equal(approved.status, 'approved', 'legitimate non-enrichment approval must be preserved');
});

test('ID-7b (MariaDB): the drift between the twins is asserted, not assumed', {
  skip: !shouldRunMariaDbIntegration(),
}, async (t) => {
  // A guard that passes on fixtures and is inert on MariaDB is a divergence defect, so the divergence itself
  // is pinned by a test. If a future change makes the MariaDB twin persist the outcome, THIS test fails and
  // forces the author to revisit the fail-closed guard deliberately.
  const config = require('../src/config');
  const pool = getPool(config.database);
  const links = createIdentityLinkMariaDbRepository(pool);
  const provider = await links.findProviderByKey(PROVIDER_MJU_SSO);

  // ONE after hook, deleting the row BEFORE closing the pool. Two separate hooks would let `closePool` run
  // first (hooks run in registration order) and the delete would then fail on a closed pool - which is
  // exactly how this test failed on its first run.
  t.after(async () => {
    try {
      await pool.query('DELETE FROM employee_identity_links WHERE provider_subject = ?', ['id7b-mariadb-drift-1']);
    } finally {
      await closePool();
    }
  });

  // Pre-clean, so this test is RE-RUNNABLE on a used database. The suite's `after` hook cannot help if a
  // previous run died before it (which happened on this test's first attempt), and a duplicate-key failure
  // then looks like a product defect. The repo records "not re-runnable on a used DB" as a known annoyance
  // for another MariaDB suite; this one avoids it.
  await pool.query(
    'DELETE FROM employee_identity_links WHERE provider_subject IN (?, ?)',
    [SUBJECT, SUBJECT_OPERATOR],
  );

  // Pre-clean, so this test is RE-RUNNABLE on a used database. The suite's `after` hook cannot help if a
  // previous run died before it (which happened on this test's first attempt), and a duplicate-key failure
  // then looks like a product defect. The repo records "not re-runnable on a used DB" as a known annoyance
  // for another MariaDB suite; this one avoids it.
  await pool.query(
    'DELETE FROM employee_identity_links WHERE provider_subject = ?',
    ['id7b-mariadb-drift-1'],
  );

  const link = await links.insertLink({
    employeeUid: '22222222-2222-2222-2222-222222222222',
    providerId: provider.id,
    providerSubject: 'id7b-mariadb-drift-1',
    subjectType: 'opaque',
    status: 'candidate',
    confidence: 'high',
    source: 'mju_person_enrich',
    enrichmentOutcome: 'found',
  });

  const [columns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identity_links'
        AND COLUMN_NAME = 'enrichment_outcome'`,
  );

  assert.equal(
    columns.length,
    0,
    'enrichment_outcome now EXISTS on employee_identity_links. That is good news, but it invalidates the '
    + 'fail-closed-on-absence guard as a permanent posture: switch the guard to the ALLOWED_ENRICHMENT_OUTCOMES '
    + 'check alone, add the column to BOTH twins, and update this test to assert the round trip instead.',
  );
  assert.equal(link.enrichmentOutcome, null, 'the read-back must be null while the column is absent');
});
