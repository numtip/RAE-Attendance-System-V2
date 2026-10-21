/**
 * F9 — national-ID protection: versioned HMAC, rotation, masking, and leakage guards.
 *
 * Synthetic data only. Every identifier below is invented and every key is a throwaway test constant.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LOOKUP_DIGEST,
  MIN_KEY_BYTES,
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
  containsNationalIdLike,
  normalizeKeys,
  createNationalIdProtector,
  protectorFromEnv,
} = require('../src/security/nationalIdContract');

/** 32-byte throwaway keys. Not secret, not used anywhere real. */
const KEY_V1 = 'k'.repeat(MIN_KEY_BYTES);
const KEY_V2 = 'm'.repeat(MIN_KEY_BYTES);

/** Synthetic 13-digit values. The checksum is irrelevant to the HMAC tests; canonicalisation is what matters. */
const ID_A = '9900000000002';
const ID_B = '9900000000003';
const ID_C = '9900000000004';

const protector = () => createNationalIdProtector({ keys: { 1: KEY_V1, 2: KEY_V2 } });

// --- canonicalisation --------------------------------------------------------------------------------

/** Builds the same ID in the four encodings this project has been bitten by, without hand-counting digits. */
const toThaiDigits = (s) => s.replace(/\d/g, (d) => '๐๑๒๓๔๕๖๗๘๙'[Number(d)]);
const toFullWidth = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
const toDashed = (s) => s.split('').join('-');
const toSpaced = (s) => s.split('').join(' ');

test('canonicalisation accepts the four encodings and folds them to one form', () => {
  const forms = [
    ['plain', ID_A],
    ['spaced', toSpaced(ID_A)],
    ['dashed', toDashed(ID_A)],
    ['thai', toThaiDigits(ID_A)],
    ['full-width', toFullWidth(ID_A)],
  ];
  for (const [label, form] of forms) {
    assert.equal(canonicalizeNationalId(form), ID_A, `failed to canonicalise the ${label} encoding`);
  }
});

test('canonicalisation FAILS CLOSED: anything that is not 13 digits becomes empty', () => {
  for (const bad of ['', null, undefined, '123', '12345678901234', 'abc', '990000000000a', '990000000000 2 3', {}, []]) {
    assert.equal(canonicalizeNationalId(bad), '', `${JSON.stringify(bad)} must canonicalise to ''`);
  }
});

test('the checksum helper rejects an obviously wrong digit', () => {
  assert.equal(isValidNationalIdChecksum('9900000000002'), false, 'this synthetic value is not checksum-valid');
  // A checksum-valid value built at runtime — never committed as a literal.
  const twelve = '000000000001';
  const sum = twelve.split('').reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  const valid = twelve + String((11 - (sum % 11)) % 10);
  assert.equal(isValidNationalIdChecksum(valid), true);
});

// --- masking -----------------------------------------------------------------------------------------

test('masking keeps only the last four digits and never the full value', () => {
  const masked = maskNationalId(ID_A);
  assert.equal(masked, '****0002');
  assert.equal(masked.includes(ID_A), false);
  assert.equal(maskNationalId('nonsense'), '[redacted]');
  assert.equal(maskNationalId(null), '[redacted]');
});

test('free-text detection finds a national ID in any encoding', () => {
  assert.equal(containsNationalIdLike(`error near ${ID_A}`), true);
  assert.equal(containsNationalIdLike(`error near ${toDashed(ID_A)}`), true);
  assert.equal(containsNationalIdLike(`error near ${toThaiDigits(ID_A)}`), true);
  assert.equal(containsNationalIdLike(`error near ${toFullWidth(ID_A)}`), true);
  assert.equal(containsNationalIdLike(`two ids ${ID_A} ${ID_B}`), true);
  assert.equal(containsNationalIdLike('no identifier here'), false);
  assert.equal(containsNationalIdLike('order 12345 shipped'), false);
  assert.equal(containsNationalIdLike(null), false);
});

// --- key handling ------------------------------------------------------------------------------------

test('a missing key is an error, never a fallback to plaintext or an unkeyed hash', () => {
  assert.throws(() => createNationalIdProtector({}), (e) => e.code === 'NATIONAL_ID_KEY_MISSING');
  assert.throws(() => createNationalIdProtector({ keys: {} }), (e) => e.code === 'NATIONAL_ID_KEY_MISSING');
  assert.throws(() => protectorFromEnv({}), (e) => e.code === 'NATIONAL_ID_KEY_MISSING');
});

test('a short key is rejected rather than silently weakening the digest', () => {
  assert.throws(() => createNationalIdProtector({ keys: { 1: 'short' } }), (e) => e.code === 'NATIONAL_ID_KEY_TOO_SHORT');
});

test('base64 keys are accepted and decoded; utf8 keys are accepted as bytes', () => {
  const base64Key = Buffer.alloc(32, 7).toString('base64');
  const a = normalizeKeys({ 1: base64Key });
  assert.equal(a.get(1).length, 32);
  const b = normalizeKeys({ 1: KEY_V1 });
  assert.equal(b.get(1).length, MIN_KEY_BYTES);
});

test('keys parse from both env forms, with explicit versions preferred', () => {
  const many = protectorFromEnv({ NATIONAL_ID_HMAC_KEYS: `1:${KEY_V1},2:${KEY_V2}` });
  assert.equal(many.writeVersion, 2);
  const single = protectorFromEnv({ NATIONAL_ID_HMAC_KEY: KEY_V1 });
  assert.equal(single.writeVersion, 1);
  const numbered = protectorFromEnv({ NATIONAL_ID_HMAC_KEY_V3: KEY_V1 });
  assert.equal(numbered.writeVersion, 3);
});

// --- the core property: HMAC, not a bare hash --------------------------------------------------------

test('the lookup is keyed: the same ID under different keys yields different digests', () => {
  const v1Only = createNationalIdProtector({ keys: { 1: KEY_V1 } });
  const v2Only = createNationalIdProtector({ keys: { 1: KEY_V2 } });
  const a = v1Only.protect(ID_A);
  const b = v2Only.protect(ID_A);
  assert.notEqual(a.lookup, b.lookup, 'a different key must produce a different digest');
});

test('the lookup is NOT a plain sha256 of the ID (an unkeyed hash would be reversible by enumeration)', () => {
  const { createHash } = require('node:crypto');
  const plain = createHash('sha256').update(ID_A).digest('hex');
  const keyed = protector().protect(ID_A).lookup;
  assert.notEqual(keyed, plain, 'the stored digest must not equal sha256(id)');
});

test('the digest is lowercase 64-hex, matching the database CHECK constraint', () => {
  const { lookup } = protector().protect(ID_A);
  assert.match(lookup, LOOKUP_DIGEST);
  assert.equal(lookup, lookup.toLowerCase());
});

test('protect() refuses an invalid ID instead of hashing junk', () => {
  for (const bad of ['123', '', 'abcdefghijklm']) {
    assert.throws(() => protector().protect(bad), (e) => e.code === 'NATIONAL_ID_INVALID');
  }
});

// --- rotation ----------------------------------------------------------------------------------------

test('rotation: a new write uses the newest key while old digests stay matchable', () => {
  const p = protector();
  assert.equal(p.writeVersion, 2);

  // A row written under v1 (the old key) must still be found by a lookup today.
  const v1 = createNationalIdProtector({ keys: { 1: KEY_V1 } });
  const legacyRow = v1.protect(ID_A);

  const candidates = p.lookupCandidates(ID_A);
  assert.equal(candidates.length, 2, 'both accepted versions must be tried');
  const matches = candidates.filter((c) => c.lookup === legacyRow.lookup);
  assert.equal(matches.length, 1, 'exactly one candidate must match the legacy row');
  assert.equal(matches[0].keyVersion, 1, 'and it must be identified as version 1');
});

test('rotation: lookup candidates are newest-version-first so the common case is tried first', () => {
  const versions = protector().lookupCandidates(ID_A).map((c) => c.keyVersion);
  assert.deepEqual(versions, [2, 1]);
});

test('rotation: restricting accepted versions stops an old key from matching', () => {
  const p = createNationalIdProtector({ keys: { 1: KEY_V1, 2: KEY_V2 }, acceptVersions: [2] });
  const legacy = createNationalIdProtector({ keys: { 1: KEY_V1 } }).protect(ID_A);
  assert.equal(p.lookupCandidates(ID_A).some((c) => c.lookup === legacy.lookup), false);
});

test('rotation: planReindex reports what would need rewriting, without doing it', () => {
  const plan = protector().planReindex([
    { id: 1, keyVersion: 2 },
    { id: 2, keyVersion: 1 },
    { id: 3, keyVersion: null },
    { id: 4, keyVersion: 2 },
  ]);
  assert.equal(plan.writeVersion, 2);
  assert.equal(plan.alreadyCurrent, 2);
  assert.equal(plan.needsReindex, 2);
  assert.equal(plan.requiresRawValues, true);
  assert.deepEqual(plan.targets.map((t) => t.id), [2, 3]);
});

test('rotation: an unknown writeVersion is rejected', () => {
  assert.throws(
    () => createNationalIdProtector({ keys: { 1: KEY_V1 }, writeVersion: 9 }),
    (e) => e.code === 'NATIONAL_ID_KEY_VERSION_INVALID',
  );
});

// --- replay / duplicate / collision ------------------------------------------------------------------

test('the same ID always yields the same digest (idempotent, so a replay cannot create a second row)', () => {
  const p = protector();
  assert.equal(p.protect(ID_A).lookup, p.protect(ID_A).lookup);
  assert.equal(p.protect(ID_A).keyVersion, p.protect(ID_A).keyVersion);
});

test('different IDs never collide', () => {
  const p = protector();
  const seen = new Set([ID_A, ID_B, ID_C].map((id) => p.protect(id).lookup));
  assert.equal(seen.size, 3);
});

test('digest comparison is constant-time and rejects malformed input', () => {
  const p = protector();
  const a = p.protect(ID_A).lookup;
  assert.equal(p.digestsEqual(a, a), true);
  assert.equal(p.digestsEqual(a, p.protect(ID_B).lookup), false);
  assert.equal(p.digestsEqual(a, 'not-a-digest'), false);
  assert.equal(p.digestsEqual(null, a), false);
});

// --- PII leakage -------------------------------------------------------------------------------------

test('no exported result carries the raw national ID', () => {
  const p = protector();
  const protectedValue = p.protect(ID_A);
  const serialized = JSON.stringify(protectedValue);
  assert.equal(serialized.includes(ID_A), false, 'protect() must not echo the raw value');
  assert.equal(serialized.includes('9900000000'), false);
  assert.ok(serialized.includes('****0002'), 'the masked form is what may be shown');

  const candidates = JSON.stringify(p.lookupCandidates(ID_A));
  assert.equal(candidates.includes(ID_A), false);
});

test('an error raised for an invalid ID does not echo the input', () => {
  try {
    protector().protect('990000000000'); // 12 digits
  } catch (err) {
    assert.equal(err.message.includes('990000000000'), false);
  }
});

test('masking is the only representation that survives into a log-shaped string', () => {
  const p = protector();
  const logLine = `employee linked national id ${p.protect(ID_A).masked} under key v${p.protect(ID_A).keyVersion}`;
  assert.equal(containsNationalIdLike(logLine), false, 'a masked log line must not look like a national ID');
});
