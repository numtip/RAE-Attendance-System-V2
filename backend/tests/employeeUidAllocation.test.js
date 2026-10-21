/**
 * F4 regression tests — UUIDv4 / Immutable / One Person One UID / No Automatic Identity Merge.
 *
 * Synthetic data only. No real employee record, code, national ID or email appears in this file.
 *
 * National IDs are modelled the way production stores them: `employee_identifier.id_value` holds an HMAC
 * lookup digest for `national_id`, never the digits. The fixtures below therefore carry `national_id_lookup`
 * on the existing side and raw digits only on the candidate side, with an injected lookup function — the exact
 * shape an importer must use.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  POLICY,
  ACTIONS,
  REASONS,
  WARNINGS,
  isUuidV4,
  assertUuidV4,
  allocateEmployeeUid,
  assertEmployeeUidUnchanged,
  assertNoAutomaticMerge,
  canonicalNationalId,
  normalizeIdentifiers,
  planIdentityAllocation,
} = require('../src/domain/employeeUidAllocation');

const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const UID_C = '33333333-3333-4333-8333-333333333333';

/** Stand-ins for HMAC-SHA-256 digests. Not real identifiers, not derived from anyone. */
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const NATIONAL_ID_1 = '9900000000002';
const NATIONAL_ID_2 = '9900000000003';

/** Deterministic factory so a test can prove *which* value was used, not where it came from. */
function sequenceFactory(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

/** Implements the importer's contract: raw digits -> stored digest, or null when it cannot be computed. */
function lookupStub(map = {}) {
  return (raw) => map[raw] ?? null;
}

const LOOKUP = lookupStub({ [NATIONAL_ID_1]: DIGEST_A, [NATIONAL_ID_2]: DIGEST_B });

function existingRow(overrides = {}) {
  return {
    employeeUid: UID_A,
    identifiers: [
      { type: 'facescan_id', value: '9001' },
      { type: 'national_id_lookup', value: DIGEST_A },
    ],
    email: 'fixture.person.one@example.test',
    fullName: 'Fixture Person One',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    candidateRef: 'row-1',
    identifiers: { facescan_id: '9001', national_id: NATIONAL_ID_1 },
    email: 'fixture.person.one@example.test',
    fullName: 'Fixture Person One',
    ...overrides,
  };
}

// --- 1. Allocation -----------------------------------------------------------------------------------

test('policy is frozen and declares the four owner-approved rules', () => {
  assert.equal(POLICY.id, 'F4');
  assert.equal(POLICY.uid_scheme, 'uuid_v4');
  assert.equal(POLICY.immutable, true);
  assert.equal(POLICY.one_person_one_uid, true);
  assert.equal(POLICY.automatic_merge, false);
  assert.equal(POLICY.national_id_key, 'lookup_digest_only');
  assert.ok(Object.isFrozen(POLICY));
});

test('a new person gets a version-4 UUID', () => {
  const { employeeUid, action } = allocateEmployeeUid({ uuidFactory: sequenceFactory([UID_A]) });
  assert.equal(employeeUid, UID_A);
  assert.equal(action, ACTIONS.CREATE);
  assert.equal(isUuidV4(employeeUid), true);
});

test('the UID generator is called with no arguments, so no identifier can influence it', () => {
  const calls = [];
  const uuidFactory = (...args) => {
    calls.push(args);
    return UID_A;
  };
  // Identifiers are deliberately offered to the allocator. It must not forward them to the generator.
  allocateEmployeeUid({ uuidFactory, identifiers: { facescan_id: '9001' }, nationalId: NATIONAL_ID_1 });
  assert.deepEqual(calls, [[]]);
});

test('the default generator produces distinct, valid v4 values (not derived from anything)', () => {
  const first = allocateEmployeeUid().employeeUid;
  const second = allocateEmployeeUid().employeeUid;
  assert.equal(isUuidV4(first), true);
  assert.equal(isUuidV4(second), true);
  assert.notEqual(first, second, 'two allocations must not collide');
});

test('a non-v4 value from the generator is rejected instead of stored', () => {
  const v1 = 'f47ac10b-58cc-1372-a567-0e02b2c3d479';
  assert.throws(
    () => allocateEmployeeUid({ uuidFactory: () => v1 }),
    (err) => err.status === 500 && err.code === 'EMPLOYEE_UID_INVALID_GENERATOR',
  );
});

test('a hand-built, non-UUID employee_uid is rejected and the value is not echoed', () => {
  for (const bad of ['EMP-9001', '9001', '', null, 'not-a-uuid', '11111111-1111-1111-1111-111111111111']) {
    assert.equal(isUuidV4(bad), false);
  }
  assert.throws(() => assertUuidV4('EMP-9001'), (err) => err.code === 'EMPLOYEE_UID_INVALID');
  try {
    assertUuidV4('EMP-9001');
  } catch (err) {
    assert.equal(err.message.includes('EMP-9001'), false);
  }
});

test('re-import reuses the stored UID without calling the generator', () => {
  let called = false;
  const { employeeUid, action } = allocateEmployeeUid({
    existingUid: UID_B,
    uuidFactory: () => {
      called = true;
      return UID_C;
    },
  });
  assert.equal(employeeUid, UID_B);
  assert.equal(action, ACTIONS.REUSE);
  assert.equal(called, false, 'a re-import must not generate a new UID');
});

// --- 2. Immutability ---------------------------------------------------------------------------------

test('proposing a different UID for an existing person fails closed', () => {
  assert.equal(assertEmployeeUidUnchanged({ employeeUid: UID_A, proposedEmployeeUid: UID_A }), UID_A);
  assert.throws(
    () => assertEmployeeUidUnchanged({ employeeUid: UID_A, proposedEmployeeUid: UID_B }),
    (err) => err.status === 409 && err.code === 'EMPLOYEE_UID_IMMUTABLE',
  );
  assert.throws(
    () => assertEmployeeUidUnchanged({ employeeUid: UID_A }),
    (err) => err.code === 'EMPLOYEE_UID_MISSING',
  );
});

test('merging two identified people is refused unless the owner approves it', () => {
  assert.equal(assertNoAutomaticMerge({ sourceEmployeeUids: [UID_A, UID_A, null] }), true);
  assert.throws(
    () => assertNoAutomaticMerge({ sourceEmployeeUids: [UID_A, UID_B] }),
    (err) => err.status === 409 && err.code === 'IDENTITY_MERGE_NOT_AUTOMATIC',
  );
});

// --- 3. National IDs are lookup keys, never raw keys -------------------------------------------------

test('a candidate national ID is converted to its lookup digest before matching', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ identifiers: { national_id: NATIONAL_ID_1 } })],
    existing: [existingRow({ identifiers: [{ type: 'national_id_lookup', value: DIGEST_A }] })],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.REUSE, 'a raw ID must match through its digest');
  assert.equal(plan.decisions[0].employeeUid, UID_A);
  assert.ok(plan.decisions[0].warnings.includes(WARNINGS.NATIONAL_ID_LOOKED_UP));
});

test('a raw national ID with no lookup function is quarantined, never turned into a second UID', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ identifiers: { national_id: NATIONAL_ID_1 } })],
    existing: [existingRow({ identifiers: [{ type: 'national_id_lookup', value: DIGEST_A }] })],
  });
  assert.equal(plan.decisions[0].action, ACTIONS.QUARANTINE);
  assert.equal(plan.decisions[0].employeeUid, null);
  assert.deepEqual(plan.decisions[0].reasons, [REASONS.NATIONAL_ID_LOOKUP_UNAVAILABLE]);
  assert.equal(plan.summary.create, 0);
});

test('a lookup function that cannot produce a digest also quarantines', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ identifiers: { national_id: NATIONAL_ID_1 } })],
    existing: [],
    nationalIdLookup: () => null,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.QUARANTINE);
  assert.deepEqual(plan.decisions[0].reasons, [REASONS.NATIONAL_ID_LOOKUP_UNAVAILABLE]);
});

test('an existing row that supplies a raw national ID fails closed rather than being silently ignored', () => {
  // The database stores a digest, so a raw value on the existing side is a caller error that could hide a
  // duplicate. It must not be quietly dropped.
  assert.throws(
    () => planIdentityAllocation({
      candidates: [candidate()],
      existing: [existingRow({ identifiers: [{ type: 'national_id', value: NATIONAL_ID_1 }] })],
    }),
    (err) => err.status === 500 && err.code === 'EXISTING_NATIONAL_ID_UNVERIFIABLE',
  );
  // With the lookup function available, the same input is accepted and matches.
  const plan = planIdentityAllocation({
    candidates: [candidate({ identifiers: { national_id: NATIONAL_ID_1 } })],
    existing: [existingRow({ identifiers: [{ type: 'national_id', value: NATIONAL_ID_1 }] })],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.REUSE);
  assert.equal(plan.decisions[0].employeeUid, UID_A);
});

test('a 64-hex digest is accepted as a lookup key and a short one is not', () => {
  assert.deepEqual(normalizeIdentifiers({ national_id_lookup: DIGEST_A }).matchKeys, { national_id_lookup: DIGEST_A });
  assert.deepEqual(normalizeIdentifiers({ national_id_lookup: 'abc' }).matchKeys, {});
  assert.deepEqual(normalizeIdentifiers({ national_id_lookup: 'zz'.repeat(32) }).matchKeys, {});
});

test('a national ID that is not 13 digits is treated as absent, never as raw text', () => {
  assert.equal(normalizeIdentifiers({ national_id: '123' }).nationalId, null);
  assert.equal(normalizeIdentifiers({ national_id: NATIONAL_ID_1 }).nationalId, NATIONAL_ID_1);
  assert.equal(
    normalizeIdentifiers({ national_id: '9 9 0 0 0 0 0 0 0 0 0 0 2' }).nationalId,
    NATIONAL_ID_1,
  );
  // Thai digits fold to ASCII, so a cell entered in Thai script resolves to the same identifier.
  assert.equal(normalizeIdentifiers({ national_id: '๙๙๐๐๐๐๐๐๐๐๐๐๒' }).nationalId, NATIONAL_ID_1);
  assert.deepEqual(normalizeIdentifiers({ sso_subject: 'x', name: 'y' }).matchKeys, {});
  assert.equal(canonicalNationalId(NATIONAL_ID_1), NATIONAL_ID_1);
});

// --- 4. Planning: create / reuse ---------------------------------------------------------------------

test('an empty registry allocates a UID for every candidate', () => {
  const plan = planIdentityAllocation({
    candidates: [
      { candidateRef: 'row-1', identifiers: { facescan_id: '9001' } },
      { candidateRef: 'row-2', identifiers: { facescan_id: '9002' } },
    ],
    uuidFactory: sequenceFactory([UID_A, UID_B]),
  });
  assert.deepEqual(plan.summary, { total: 2, create: 2, reuse: 0, quarantine: 0, conflict: 0 });
  assert.deepEqual(plan.decisions.map((d) => d.employeeUid), [UID_A, UID_B]);
});

test('a re-import matches on identifier ownership and reuses the same UID', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate()],
    existing: [existingRow()],
    uuidFactory: sequenceFactory([UID_C]),
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.summary.reuse, 1);
  assert.equal(plan.summary.create, 0);
  assert.equal(plan.decisions[0].employeeUid, UID_A);
  assert.ok(plan.decisions[0].matchedBy.includes(REASONS.IDENTIFIER_OWNED_BY_ONE_EMPLOYEE));
  assert.deepEqual(plan.decisions[0].identifiersToAttach, [], 'identifiers already owned are not re-attached');
});

test('a re-import that only adds a new identifier reuses the UID and lists only the new one', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ identifiers: { facescan_id: '9001', employee_id: 'RAE-00000001', national_id: NATIONAL_ID_1 } })],
    existing: [existingRow()],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.REUSE);
  assert.equal(plan.decisions[0].employeeUid, UID_A);
  // The national ID is already owned through its digest, so only the genuinely new identifier is listed.
  assert.deepEqual(plan.decisions[0].identifiersToAttach, ['employee_id']);
});

test('an email change on a verified identifier match is a warning, not a new identity', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ email: 'renamed.person.one@example.test' })],
    existing: [existingRow()],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.REUSE);
  assert.ok(plan.decisions[0].warnings.includes(WARNINGS.EMAIL_DIFFERS));
});

test('a name change on a verified identifier match is a warning, not a new identity', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ fullName: 'Fixture Person Renamed' })],
    existing: [existingRow()],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.REUSE);
  assert.ok(plan.decisions[0].warnings.includes(WARNINGS.NAME_DIFFERS));
});

// --- 5. Ambiguity: conflict and quarantine -----------------------------------------------------------

test('an identifier owned by two UIDs is a conflict, and no UID is handed out', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate()],
    existing: [existingRow(), existingRow({ employeeUid: UID_B, email: 'other@example.test' })],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.CONFLICT);
  assert.equal(plan.decisions[0].employeeUid, null);
  assert.ok(plan.decisions[0].reasons.includes(REASONS.IDENTIFIER_MULTIPLE_OWNERS));
  assert.deepEqual(plan.decisions[0].identifiersToAttach, []);
});

test('two strong identifiers pointing at two different employees is a conflict', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate()],
    existing: [
      existingRow({ employeeUid: UID_A, identifiers: [{ type: 'facescan_id', value: '9001' }] }),
      existingRow({ employeeUid: UID_B, identifiers: [{ type: 'national_id_lookup', value: DIGEST_A }] }),
    ],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.CONFLICT);
  assert.ok(plan.decisions[0].reasons.includes(REASONS.CROSS_IDENTIFIER_CONFLICT));
});

test('two candidate rows for the same person are a conflict, never two UIDs', () => {
  const plan = planIdentityAllocation({
    candidates: [
      candidate({ candidateRef: 'row-1' }),
      candidate({ candidateRef: 'row-2', email: 'second-sighting@example.test' }),
    ],
    uuidFactory: sequenceFactory([UID_A, UID_B]),
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.summary.conflict, 2);
  assert.equal(plan.summary.create, 0);
  assert.ok(plan.decisions.every((d) => d.reasons.includes(REASONS.DUPLICATE_WITHIN_BATCH)));
});

test('two candidate rows sharing only a national ID are also a batch conflict', () => {
  const plan = planIdentityAllocation({
    candidates: [
      { candidateRef: 'row-1', identifiers: { facescan_id: '9101', national_id: NATIONAL_ID_1 } },
      { candidateRef: 'row-2', identifiers: { facescan_id: '9102', national_id: NATIONAL_ID_1 } },
    ],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.summary.conflict, 2);
  assert.equal(plan.summary.create, 0);
});

test('a raw national ID and the same person\'s stored digest in one batch are a conflict, not two UIDs', () => {
  // Regression: batch-duplicate detection used to run BEFORE the raw national ID was hashed, so these two rows
  // were both classified CREATE and one person received two UIDs.
  const plan = planIdentityAllocation({
    candidates: [
      { candidateRef: 'row-raw', identifiers: { facescan_id: '9151', national_id: NATIONAL_ID_1 } },
      { candidateRef: 'row-digest', identifiers: { national_id_lookup: DIGEST_A } },
    ],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.summary.create, 0, 'the same person must never be created twice');
  assert.equal(plan.summary.conflict, 2);
  for (const decision of plan.decisions) {
    assert.deepEqual(decision.reasons, [REASONS.DUPLICATE_WITHIN_BATCH]);
    assert.equal(decision.employeeUid, null);
  }
});

test('a name-only candidate is quarantined and no UID is allocated', () => {
  let generated = 0;
  const plan = planIdentityAllocation({
    candidates: [{ candidateRef: 'row-7', identifiers: {}, email: 'someone@example.test', fullName: 'Some One' }],
    uuidFactory: () => {
      generated += 1;
      return UID_A;
    },
  });
  assert.equal(plan.decisions[0].action, ACTIONS.QUARANTINE);
  assert.equal(plan.decisions[0].employeeUid, null);
  assert.deepEqual(plan.decisions[0].reasons, [REASONS.NO_IDENTIFIER_SIGNAL]);
  assert.equal(generated, 0);
});

test('an email that already belongs to someone cannot create a match on its own', () => {
  const plan = planIdentityAllocation({
    candidates: [{ candidateRef: 'row-8', identifiers: {}, email: 'fixture.person.one@example.test' }],
    existing: [existingRow()],
  });
  assert.equal(plan.decisions[0].action, ACTIONS.QUARANTINE);
  assert.deepEqual(plan.decisions[0].reasons, [REASONS.EMAIL_MATCH_ONLY]);
  assert.equal(plan.decisions[0].employeeUid, null);
});

test('an explicit UID that disagrees with identifier ownership is a conflict', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ employeeUid: UID_B })],
    existing: [existingRow()],
    nationalIdLookup: LOOKUP,
  });
  assert.equal(plan.decisions[0].action, ACTIONS.CONFLICT);
  assert.ok(plan.decisions[0].reasons.includes(REASONS.CROSS_IDENTIFIER_CONFLICT));
});

test('an explicit but malformed UID is a conflict', () => {
  const plan = planIdentityAllocation({
    candidates: [candidate({ employeeUid: 'EMP-9001' })],
    existing: [],
  });
  assert.equal(plan.decisions[0].action, ACTIONS.CONFLICT);
  assert.ok(plan.decisions[0].reasons.includes(REASONS.INVALID_EMPLOYEE_UID));
});

test('two candidates claiming the same explicit UID are a conflict, never a shared identity', () => {
  const plan = planIdentityAllocation({
    candidates: [
      { candidateRef: 'row-1', employeeUid: UID_C, identifiers: { facescan_id: '9201' } },
      { candidateRef: 'row-2', employeeUid: UID_C, identifiers: { facescan_id: '9202' } },
    ],
    uuidFactory: sequenceFactory([UID_A, UID_B]),
  });
  assert.equal(plan.summary.conflict, 1, 'the second claim must be refused');
  assert.equal(plan.summary.create, 1);
  assert.ok(plan.decisions[1].reasons.includes(REASONS.DUPLICATE_EMPLOYEE_UID));
  const created = plan.decisions.filter((d) => d.action === ACTIONS.CREATE);
  assert.equal(created.length, 1);
});

test('an explicit UID for an existing person with no matching identifier is a conflict, not an attach', () => {
  // This is the "attach a stranger's identifier to an existing employee" path. It must not succeed.
  const plan = planIdentityAllocation({
    candidates: [{ candidateRef: 'row-9', employeeUid: UID_A, identifiers: { facescan_id: '7777' } }],
    existing: [existingRow()],
    uuidFactory: sequenceFactory([UID_C]),
  });
  assert.equal(plan.decisions[0].action, ACTIONS.CONFLICT);
  assert.ok(plan.decisions[0].reasons.includes(REASONS.EXPLICIT_UID_WITHOUT_IDENTIFIER_MATCH));
  assert.deepEqual(plan.decisions[0].identifiersToAttach, [], 'nothing may be attached');
});

test('a generated UID that collides with an existing employee is a hard error', () => {
  assert.throws(
    () => planIdentityAllocation({
      candidates: [{ candidateRef: 'row-1', identifiers: { facescan_id: '9301' } }],
      existing: [existingRow()],
      uuidFactory: () => UID_A,
    }),
    (err) => err.status === 500 && err.code === 'EMPLOYEE_UID_COLLISION',
  );
});

test('the injected generator colliding with an already-planned UID is a hard error', () => {
  assert.throws(
    () => planIdentityAllocation({
      candidates: [
        candidate({ candidateRef: 'row-1', identifiers: { facescan_id: '9101' } }),
        candidate({ candidateRef: 'row-2', identifiers: { facescan_id: '9102' } }),
      ],
      uuidFactory: () => UID_C,
    }),
    (err) => err.status === 500 && err.code === 'EMPLOYEE_UID_COLLISION',
  );
});

// --- 6. Historical preservation (N1) ------------------------------------------------------------------
//
// The owner-approved roster is a SUBSET of the historical population: 49 codes against a 54-code master.
// The invariant is that a partial re-import reuses the 49 UIDs it recognises and leaves the other 5 identities
// completely untouched — no new UID, no re-key, no merge, and no implication that the 5 have left.

const HISTORICAL_COUNT = 54;
const ROSTER_COUNT = 49;

function uidFor(index) {
  return `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** A synthetic registry shaped like the real one: one code per person, one UID per person. */
function historicalRegistry(count = HISTORICAL_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    employeeUid: uidFor(index + 1),
    identifiers: [{ type: 'facescan_id', value: String(9000 + index + 1) }],
    email: `fixture.person.${index + 1}@example.test`,
    fullName: `Fixture Person ${index + 1}`,
  }));
}

test('a 49-row re-import reuses every recognisable UID and creates none', () => {
  const existing = historicalRegistry();
  const rosterCodes = existing.slice(0, ROSTER_COUNT).map((row) => row.identifiers[0].value);
  const candidates = rosterCodes.map((code, index) => ({
    candidateRef: `roster-${index + 1}`,
    identifiers: { facescan_id: code },
  }));

  const plan = planIdentityAllocation({ candidates, existing });
  assert.deepEqual(plan.summary, {
    total: ROSTER_COUNT,
    create: 0,
    reuse: ROSTER_COUNT,
    quarantine: 0,
    conflict: 0,
  }, 'a re-import of known people must never allocate a UID');

  for (const [index, decision] of plan.decisions.entries()) {
    assert.equal(decision.employeeUid, existing[index].employeeUid);
    assert.deepEqual(decision.identifiersToAttach, []);
  }
});

test('the 5 people outside the roster keep their identities and are never mentioned in the plan', () => {
  const existing = historicalRegistry();
  const outside = existing.slice(ROSTER_COUNT);
  assert.equal(outside.length, HISTORICAL_COUNT - ROSTER_COUNT);
  const uidsBefore = existing.map((row) => row.employeeUid);

  const candidates = existing.slice(0, ROSTER_COUNT).map((row, index) => ({
    candidateRef: `roster-${index + 1}`,
    identifiers: { facescan_id: row.identifiers[0].value },
  }));
  const plan = planIdentityAllocation({ candidates, existing });

  const plannedUids = new Set(plan.decisions.map((d) => d.employeeUid));
  for (const person of outside) {
    assert.equal(plannedUids.has(person.employeeUid), false, 'an out-of-roster identity must not appear in the plan');
  }
  // The registry itself must be byte-identical afterwards: nothing is re-pointed, removed or rewritten.
  assert.deepEqual(existing.map((row) => row.employeeUid), uidsBefore);
  assert.equal(existing.length, HISTORICAL_COUNT);
  assert.equal(JSON.stringify(plan.decisions).includes('delete'), false);
  assert.equal(JSON.stringify(plan.decisions).includes('resign'), false);
});

test('replaying the same re-import twice produces identical UIDs (idempotent)', () => {
  const existing = historicalRegistry();
  const candidates = existing.slice(0, ROSTER_COUNT).map((row, index) => ({
    candidateRef: `roster-${index + 1}`,
    identifiers: { facescan_id: row.identifiers[0].value },
  }));
  const first = planIdentityAllocation({ candidates, existing });
  const second = planIdentityAllocation({ candidates, existing });
  assert.deepEqual(
    first.decisions.map((d) => d.employeeUid),
    second.decisions.map((d) => d.employeeUid),
  );
  assert.equal(first.summary.create, 0);
  assert.equal(second.summary.create, 0);
});

test('a brand-new person in the same batch gets a fresh UID while the 49 are reused', () => {
  const existing = historicalRegistry();
  const candidates = existing.slice(0, ROSTER_COUNT).map((row, index) => ({
    candidateRef: `roster-${index + 1}`,
    identifiers: { facescan_id: row.identifiers[0].value },
  }));
  candidates.push({ candidateRef: 'new-hire-1', identifiers: { facescan_id: '9999' } });

  const plan = planIdentityAllocation({ candidates, existing, uuidFactory: () => UID_C });
  assert.deepEqual(plan.summary, {
    total: ROSTER_COUNT + 1,
    create: 1,
    reuse: ROSTER_COUNT,
    quarantine: 0,
    conflict: 0,
  });
  const created = plan.decisions.find((d) => d.action === ACTIONS.CREATE);
  assert.equal(created.employeeUid, UID_C);
  assert.equal(existing.some((row) => row.employeeUid === UID_C), false, 'the new UID must not collide with a stored one');
});
