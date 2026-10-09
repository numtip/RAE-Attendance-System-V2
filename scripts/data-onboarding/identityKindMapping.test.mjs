import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStagedInvariants,
  buildIdentityKindMapping,
  HIP_BATCH_SOURCE,
  MJU_PERSONNEL_SOURCE,
} from './identityKindMapping.mjs';
import { buildLookup, loadIdentifierKeys } from './identifierCrypto.mjs';

// ---------- synthetic data only ----------
function keysFor({ version = 1, previous = null } = {}) {
  const env = {
    EMPLOYEE_IDENTIFIER_HMAC_KEY: Buffer.alloc(32, version + 40).toString('base64'),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: String(version),
  };
  if (previous) {
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS = Buffer.alloc(32, previous + 40).toString('base64');
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION = String(previous);
  }
  return loadIdentifierKeys(env);
}

/** Valid Thai checksum from a 12-digit synthetic prefix (prefix starts with 9 => never a real registry range we use). */
function syntheticNational(n) {
  const prefix = `9${String(n).padStart(11, '0')}`;
  const sum = [...prefix].reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  return `${prefix}${(11 - (sum % 11)) % 10}`;
}

const hipId = (n) => `HX${String(n).padStart(4, '0')}`;
const personnelOf = (n) => `PX-${String(n).padStart(5, '0')}`;
const row = (n, rowNumber, overrides = {}) => ({
  rowNumber,
  nationalId: syntheticNational(n),
  facescanId: hipId(n),
  ...overrides,
});

/** 52 CSV rows -> 50 unique: 12 MJU, 32 HIP, 6 unresolved. */
function buildBatch() {
  const rows = [];
  let rowNumber = 2;
  for (let n = 1; n <= 44; n += 1) rows.push(row(n, rowNumber++)); // 1-12 MJU, 13-44 HIP
  rows.push(row(45, rowNumber++, { facescanId: '' })); // missing HIP id
  rows.push(row(46, rowNumber++, { nationalId: '9000000000009' })); // bad checksum (synthetic)
  rows.push(row(47, rowNumber++, { facescanId: hipId(900) })); // shared HIP id ...
  rows.push(row(48, rowNumber++, { facescanId: hipId(900) })); // ... with another person
  rows.push(row(49, rowNumber++)); // same national, two HIP ids
  rows.push(row(49, rowNumber++, { facescanId: hipId(949) }));
  rows.push(row(1, rowNumber++)); // exact duplicate row #1
  rows.push(row(20, rowNumber++)); // exact duplicate row #2
  return rows;
}

function mjuRecords(range) {
  return range.map((n) => ({ personnelId: personnelOf(n), nationalId: syntheticNational(n) }));
}

const APPROVED = { approvalRef: 'APPROVAL-SYNTHETIC-1' };

test('50 unique people stay in the list: 12 MJU / 32 HIP / 6 unresolved; masked report; no raw identifiers', () => {
  const keys = keysFor();
  const rows = buildBatch();
  const { report, staged } = buildIdentityKindMapping(rows, {
    keys,
    mjuSource: { authoritative: true, records: mjuRecords([...Array(12).keys()].map((i) => i + 1)) },
    hipPolicy: APPROVED,
  });

  assert.equal(report.input.rows, 52);
  assert.equal(report.input.uniqueRows, 50);
  assert.equal(report.input.duplicateRowsCollapsed, 2);
  assert.equal(report.total, 50);
  assert.deepEqual(report.counts, { MJU: 12, HIP: 32, UNRESOLVED: 6 });
  assert.equal(report.counts.MJU + report.counts.HIP + report.counts.UNRESOLVED, 50);
  assert.equal(report.items.length, 50);
  assert.deepEqual(report.unresolvedReasons, {
    HIP_ID_MISSING: 1,
    NATIONAL_ID_CHECKSUM_INVALID: 1,
    CSV_FACESCAN_SHARED_BY_MULTIPLE_NATIONALS: 2,
    CSV_NATIONAL_MULTIPLE_FACESCAN: 2,
  });
  assert.deepEqual(report.hipBasis, { MJU_NEGATIVE_AUTHORITATIVE: 32 });
  assert.equal(report.writesDatabase, false);
  assert.deepEqual(report.invariants, {
    syntheticPersonnelIds: 0,
    ssoSubjectsCreated: 0,
    ssoRequired: 0,
    plaintextNationalIds: 0,
    rawNationalIdStorage: 'DISABLED',
  });

  // report must not leak identifiers
  const serialized = JSON.stringify(report);
  for (const n of [1, 13, 30, 44, 47, 49]) {
    assert.equal(serialized.includes(syntheticNational(n)), false, 'national id leaked');
    assert.equal(serialized.includes(hipId(n)), false, 'hip id leaked');
    assert.equal(serialized.includes(personnelOf(n)), false, 'personnel id leaked');
  }
  assert.ok(report.items.every((item) => item.maskedNationalId === '[invalid]' || /^\*+\d{4}$/.test(item.maskedNationalId)));

  // staged: MJU has exactly one MJU personnel_id; HIP has none; both keep protected national lookups only
  assert.equal(staged.length, 44);
  const hip = staged.filter((entry) => entry.kind === 'HIP');
  const mju = staged.filter((entry) => entry.kind === 'MJU');
  assert.equal(hip.length, 32);
  assert.equal(mju.length, 12);
  assert.ok(hip.every((entry) => entry.identifiers.every((id) => id.idType !== 'personnel_id')));
  assert.ok(hip.every((entry) => entry.identifiers[0].idType === 'facescan_id' && entry.identifiers[0].isPrimary));
  assert.ok(mju.every((entry) => entry.identifiers[0].idType === 'personnel_id' && entry.identifiers[0].sourceSystem === MJU_PERSONNEL_SOURCE));
  assert.ok(staged.every((entry) => entry.identifiers.filter((id) => id.idType === 'national_id').every((id) => id.idValue === undefined && /^[0-9a-f]{64}$/.test(id.lookupHmac))));
  assert.ok(staged.every((entry) => !('sso' in entry) && !('ssoSubject' in entry)));
  assert.ok(report.items.every((item) => item.sso.required === false && item.sso.createSubject === false));
});

test('MJU vs HIP identifiers never share a namespace: staged values are unique per (type, value)', () => {
  const { staged } = buildIdentityKindMapping(buildBatch(), {
    keys: keysFor(),
    mjuSource: { authoritative: true, records: mjuRecords([1, 2, 3]) },
    hipPolicy: APPROVED,
  });
  const keys = staged.flatMap((entry) => entry.identifiers.map((id) => `${id.idType}:${id.idValue ?? id.lookupHmac}`));
  assert.equal(new Set(keys).size, keys.length);
});

test('without an authoritative MJU source nothing is classified MJU, and HIP needs approval + a verified absence', () => {
  const keys = keysFor();
  const rows = [row(1, 2), row(2, 3)];
  const nonAuthoritative = { authoritative: false, records: mjuRecords([1]) };

  // MJU match but source untrusted
  let { report } = buildIdentityKindMapping(rows, { keys, mjuSource: nonAuthoritative, hipPolicy: APPROVED });
  assert.deepEqual(report.counts, { MJU: 0, HIP: 0, UNRESOLVED: 2 });
  assert.deepEqual(report.unresolvedReasons, { MJU_SOURCE_NOT_AUTHORITATIVE: 1, MJU_ABSENCE_NOT_VERIFIED: 1 });
  assert.equal(report.hipEligibleStructural, 1);

  // no approval at all
  ({ report } = buildIdentityKindMapping(rows, { keys, mjuSource: { authoritative: true, records: [] } }));
  assert.deepEqual(report.counts, { MJU: 0, HIP: 0, UNRESOLVED: 2 });
  assert.deepEqual(report.unresolvedReasons, { HIP_POLICY_NOT_APPROVED: 2 });

  // explicit operator confirmation with approval ref (basis is recorded)
  ({ report } = buildIdentityKindMapping(rows, {
    keys,
    mjuSource: null,
    hipPolicy: { ...APPROVED, acceptUnverifiedMjuAbsence: true },
  }));
  assert.deepEqual(report.counts, { MJU: 0, HIP: 2, UNRESOLVED: 0 });
  assert.deepEqual(report.hipBasis, { OPERATOR_CONFIRMED_NO_MJU_ACCOUNT: 2 });
});

test('MJU matching uses the protected National ID only: same name / different ID never matches', () => {
  const keys = keysFor();
  const records = [{ personnelId: personnelOf(1), nationalId: syntheticNational(777), displayName: 'Same Name' }];
  const { report } = buildIdentityKindMapping(
    [{ ...row(1, 2), displayName: 'Same Name' }],
    { keys, mjuSource: { authoritative: true, records }, hipPolicy: APPROVED },
  );
  assert.deepEqual(report.counts, { MJU: 0, HIP: 1, UNRESOLVED: 0 });
});

test('MJU duplicate personnel_id (two different people) is held, not guessed', () => {
  const keys = keysFor();
  const records = [
    { personnelId: 'PX-DUP', nationalId: syntheticNational(1) },
    { personnelId: 'PX-DUP', nationalId: syntheticNational(2) },
  ];
  const { report } = buildIdentityKindMapping([row(1, 2), row(2, 3)], { keys, mjuSource: { authoritative: true, records }, hipPolicy: APPROVED });
  assert.deepEqual(report.unresolvedReasons, { MJU_PERSONNEL_ID_DUPLICATE: 2 });
  assert.equal(report.counts.MJU, 0);
});

test('MJU record matching two CSV people / ambiguous multi-match is held', () => {
  const keys = keysFor();
  const records = [
    { personnelId: personnelOf(1), nationalId: syntheticNational(1) },
    { personnelId: personnelOf(2), nationalId: syntheticNational(1) },
  ];
  const { report } = buildIdentityKindMapping([row(1, 2)], { keys, mjuSource: { authoritative: true, records }, hipPolicy: APPROVED });
  assert.deepEqual(report.unresolvedReasons, { MJU_MATCH_AMBIGUOUS: 1 });
});

test('ID collision: HIP id equal to someone else\'s personnel_id is held; equal to own personnel_id is fine', () => {
  const keys = keysFor();
  // person 1 is MJU with personnel_id "5001"; person 2's HIP id is also "5001"
  const mjuSource = { authoritative: true, records: [{ personnelId: '5001', nationalId: syntheticNational(1) }] };
  const rows = [
    row(1, 2, { facescanId: 'A1' }),
    row(2, 3, { facescanId: '5001' }),
    row(3, 4, { facescanId: 'A3' }),
  ];
  let { report } = buildIdentityKindMapping(rows, { keys, mjuSource, hipPolicy: APPROVED });
  assert.deepEqual(report.counts, { MJU: 1, HIP: 1, UNRESOLVED: 1 });
  assert.deepEqual(report.unresolvedReasons, { NAMESPACE_COLLISION_PERSONNEL_ID: 1 });
  assert.equal(report.items.find((item) => item.rowNumber === 3).kind, 'UNRESOLVED');

  // the person who OWNS personnel_id 5001 may use the same text as HIP device id
  ({ report } = buildIdentityKindMapping([row(1, 2, { facescanId: '5001' })], { keys, mjuSource, hipPolicy: APPROVED }));
  assert.deepEqual(report.counts, { MJU: 1, HIP: 0, UNRESOLVED: 0 });

  // existing DB personnel_id of another employee
  ({ report } = buildIdentityKindMapping([row(2, 2, { facescanId: '6001' })], {
    keys,
    hipPolicy: APPROVED,
    mjuSource: { authoritative: true, records: [] },
    existingIdentifiers: [{ employeeUid: 'uid-x', idType: 'personnel_id', idValue: '6001', status: 'active' }],
  }));
  assert.deepEqual(report.unresolvedReasons, { NAMESPACE_COLLISION_PERSONNEL_ID: 1 });
});

test('existing identifiers: already mapped / attach-review / foreign facescan / conflict; rotation window; plaintext rejected', () => {
  const v1 = keysFor({ version: 1 });
  const rotating = keysFor({ version: 2, previous: 1 });
  const hmac = (keys, n) => buildLookup('national_id', syntheticNational(n), keys).lookup_hmac;
  const existingIdentifiers = [
    // person 1: both identifiers on uid-a (stored under v1)
    { employeeUid: 'uid-a', idType: 'national_id', lookupHmac: hmac(v1, 1), status: 'active' },
    { employeeUid: 'uid-a', idType: 'facescan_id', idValue: hipId(1), status: 'active' },
    // person 2: national only
    { employeeUid: 'uid-b', idType: 'national_id', lookupHmac: hmac(v1, 2), status: 'active' },
    // person 3: HIP id held by another employee, national unknown
    { employeeUid: 'uid-c', idType: 'facescan_id', idValue: hipId(3), status: 'active' },
    // person 4: national on uid-d, HIP id on uid-e
    { employeeUid: 'uid-d', idType: 'national_id', lookupHmac: hmac(v1, 4), status: 'active' },
    { employeeUid: 'uid-e', idType: 'facescan_id', idValue: hipId(4), status: 'active' },
  ];
  const { report } = buildIdentityKindMapping([row(1, 2), row(2, 3), row(3, 4), row(4, 5), row(5, 6)], {
    keys: rotating,
    mjuSource: { authoritative: true, records: [] },
    hipPolicy: APPROVED,
    existingIdentifiers,
  });
  const byRow = Object.fromEntries(report.items.map((item) => [item.rowNumber, item]));
  assert.equal(byRow[2].existingAction, 'ALREADY_MAPPED');
  assert.equal(byRow[3].existingAction, 'ATTACH_REVIEW');
  assert.equal(byRow[4].reason, 'FACESCAN_ID_ALREADY_ASSIGNED');
  assert.equal(byRow[5].reason, 'EXISTING_IDENTIFIERS_CONFLICT');
  assert.equal(byRow[6].existingAction, undefined);
  assert.deepEqual(report.existingActions, { ALREADY_MAPPED: 1, ATTACH_REVIEW: 1 });

  // v2-only keys can no longer see v1 rows => treated as new (documents why previous key must stay configured)
  const v2Only = keysFor({ version: 2 });
  const second = buildIdentityKindMapping([row(1, 2)], {
    keys: v2Only, mjuSource: { authoritative: true, records: [] }, hipPolicy: APPROVED, existingIdentifiers,
  });
  assert.equal(second.report.items[0].reason, 'FACESCAN_ID_ALREADY_ASSIGNED');

  // plaintext National ID in a snapshot is rejected without echoing it
  const plain = syntheticNational(1);
  assert.throws(
    () => buildIdentityKindMapping([row(1, 2)], {
      keys: rotating,
      existingIdentifiers: [{ employeeUid: 'uid-z', idType: 'national_id', idValue: plain, status: 'active' }],
    }),
    (error) => error.message === 'PLAINTEXT_NATIONAL_ID_IN_SNAPSHOT' && !error.message.includes(plain),
  );
});

test('fail closed without keys; rows must be an array', () => {
  assert.throws(() => buildIdentityKindMapping([row(1, 2)], {}), /HMAC key is required/);
  assert.throws(() => buildIdentityKindMapping('x', { keys: keysFor() }), /rows must be an array/);
});

test('invariant guard refuses synthetic personnel_id, HIP with personnel_id, plaintext national and SSO subjects', () => {
  const lookup = 'a'.repeat(64);
  const national = { idType: 'national_id', lookupHmac: lookup, lookupKeyVersion: 1 };
  assert.throws(() => assertStagedInvariants([{
    kind: 'HIP',
    identifiers: [{ idType: 'facescan_id', idValue: 'H1' }, { idType: 'personnel_id', idValue: 'P1', sourceSystem: MJU_PERSONNEL_SOURCE }],
  }]), /INVARIANT_HIP_WITH_PERSONNEL_ID/);
  assert.throws(() => assertStagedInvariants([{
    kind: 'MJU',
    identifiers: [{ idType: 'personnel_id', idValue: 'P1', sourceSystem: HIP_BATCH_SOURCE }, national],
  }]), /INVARIANT_PERSONNEL_ID_SOURCE/);
  assert.throws(() => assertStagedInvariants([{
    kind: 'HIP',
    identifiers: [{ idType: 'national_id', idValue: syntheticNational(1) }],
  }]), /INVARIANT_NATIONAL_ID_NOT_PROTECTED/);
  assert.throws(() => assertStagedInvariants([{
    kind: 'HIP',
    ssoSubject: 'x',
    identifiers: [{ idType: 'facescan_id', idValue: 'H1' }, national],
  }]), /INVARIANT_SSO_SUBJECT_STAGED/);
  assert.throws(() => assertStagedInvariants([
    { kind: 'HIP', identifiers: [{ idType: 'facescan_id', idValue: 'H1' }] },
    { kind: 'HIP', identifiers: [{ idType: 'facescan_id', idValue: 'H1' }] },
  ]), /INVARIANT_DUPLICATE_FACESCAN_ID/);
});
