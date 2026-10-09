import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildLookup,
  buildLookupCandidates,
  decryptRawIdentifier,
  encryptRawIdentifier,
  loadIdentifierKeys,
  maskNationalId,
} from './identifierCrypto.mjs';
import { buildImportBatchFromPersonRecords, redactImportBatchSummary } from './lib.mjs';

// All values below are synthetic/random; no real identifier or key is used.
const FAKE_ID = '9999999999991';
const b64 = (n) => randomBytes(n).toString('base64');

function env(overrides = {}) {
  return {
    EMPLOYEE_IDENTIFIER_HMAC_KEY: b64(32),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '2',
    EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: b64(32),
    EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID: 'enc-test-1',
    ...overrides,
  };
}

test('lookup is HMAC-SHA-256 with key version, not a plain SHA of the ID', () => {
  const keys = loadIdentifierKeys(env());
  const lookup = buildLookup('national_id', FAKE_ID, keys);
  assert.match(lookup.lookup_hmac, /^[0-9a-f]{64}$/);
  assert.equal(lookup.key_version, 2);
  const plainSha = createHash('sha256').update(FAKE_ID).digest('hex');
  assert.notEqual(lookup.lookup_hmac, plainSha);
  assert.notEqual(buildLookup('national_id', FAKE_ID, loadIdentifierKeys(env())).lookup_hmac, lookup.lookup_hmac);
  assert.equal(buildLookup('national_id', '999-9999-99999-1', keys).lookup_hmac, lookup.lookup_hmac);
});

test('rotation window exposes current and previous lookups with their versions', () => {
  const e = env({
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: b64(32),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1',
  });
  const candidates = buildLookupCandidates('national_id', FAKE_ID, loadIdentifierKeys(e));
  assert.deepEqual(candidates.map((c) => c.key_version), [2, 1]);
  assert.notEqual(candidates[0].lookup_hmac, candidates[1].lookup_hmac);
  assert.throws(
    () => loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: b64(32), EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '2' })),
    { code: 'KEY_VERSION_DUPLICATE' },
  );
});

test('HMAC and encryption keys must be distinct and well-formed', () => {
  const shared = b64(32);
  assert.throws(
    () => loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_HMAC_KEY: shared, EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: shared })),
    { code: 'KEY_REUSE_HMAC_AND_ENCRYPTION' },
  );
  assert.throws(() => loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_HMAC_KEY: b64(8) })), { code: 'KEY_TOO_SHORT:EMPLOYEE_IDENTIFIER_HMAC_KEY' });
  assert.throws(() => loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: b64(16) })), /KEY_BAD_LENGTH/);
  assert.throws(() => loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: 'x' })), /KEY_VERSION_INVALID/);
  assert.throws(() => loadIdentifierKeys({}), /KEY_VERSION_INVALID|KEY_MISSING/);
});

test('errors never leak identifier or key material', () => {
  const e = env();
  for (const fn of [
    () => buildLookup('national_id', 'not-an-id', loadIdentifierKeys(e)),
    () => loadIdentifierKeys({ ...e, EMPLOYEE_IDENTIFIER_HMAC_KEY: 'bad key value!' }),
  ]) {
    try {
      fn();
      assert.fail('should throw');
    } catch (error) {
      assert.ok(!error.message.includes('not-an-id'));
      assert.ok(!error.message.includes('bad key value'));
      assert.ok(!error.message.includes(e.EMPLOYEE_IDENTIFIER_HMAC_KEY));
    }
  }
});

test('raw ID encryption needs an approved necessity ref and round-trips with AES-256-GCM', () => {
  const keys = loadIdentifierKeys(env());
  assert.throws(() => encryptRawIdentifier('national_id', FAKE_ID, keys), { code: 'NECESSITY_APPROVAL_REQUIRED' });
  const noEnc = loadIdentifierKeys({ ...env(), EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: '' });
  assert.throws(
    () => encryptRawIdentifier('national_id', FAKE_ID, noEnc, { necessityApprovalRef: 'APPROVAL-TEST' }),
    { code: 'ENCRYPTION_KEY_NOT_CONFIGURED' },
  );
  const envelope = encryptRawIdentifier('national_id', FAKE_ID, keys, { necessityApprovalRef: 'APPROVAL-TEST' });
  assert.equal(envelope.iv.length, 12);
  assert.equal(envelope.auth_tag.length, 16);
  assert.ok(!envelope.ciphertext.includes(Buffer.from(FAKE_ID)));
  assert.equal(decryptRawIdentifier(envelope, keys), FAKE_ID);

  const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => decryptRawIdentifier(tampered, keys), { code: 'DECRYPT_FAILED' });
  const wrongBinding = { ...envelope, lookup_hmac: 'a'.repeat(64) };
  assert.throws(() => decryptRawIdentifier(wrongBinding, keys), { code: 'DECRYPT_FAILED' });
});

test('batch with keys emits HMAC + version only; output never contains raw IDs or plain SHA', async () => {
  const keys = loadIdentifierKeys(env());
  const persons = Array.from({ length: 3 }, (_, i) => ({
    personnelId: `SYN-P-${i}`,
    nationalId: `999999999999${i}`,
    facescanId: `SYN-FS-${i}`,
    first_name_th: 'ทดสอบ',
    last_name_th: `คน${i}`,
    email: `syn${i}@example.test`,
    department: 'RAE',
    employee_type: 'department',
    status: 'active',
  }));
  const batch = buildImportBatchFromPersonRecords(
    persons,
    { source_batch_id: 'test-hmac', person_source: 'mju_person_api', sequence_start: 1 },
    { identifierKeys: keys },
  );
  assert.equal(batch.readyCount, 3);
  assert.ok(batch.bundle.identifier_audit.every((a) => /^[0-9a-f]{64}$/.test(a.national_id_lookup_hmac) && a.national_id_key_version === 2));
  const output = JSON.stringify([batch.bundle, batch.ready, redactImportBatchSummary(batch)]);
  for (const person of persons) {
    assert.ok(!output.includes(person.nationalId), 'raw national id leaked');
    const plain = createHash('sha256').update(person.nationalId).digest('hex');
    assert.ok(!output.includes(plain), 'plain sha leaked');
  }
  assert.ok(!/national_id_sha256/.test(output));

  const invalid = buildImportBatchFromPersonRecords(
    [{ ...persons[0], nationalId: 'SYN-NID-1' }],
    { source_batch_id: 'test-invalid', person_source: 'mju_person_api' },
    { identifierKeys: keys },
  );
  assert.equal(invalid.readyCount, 0);
  assert.equal(invalid.hold[0].reason, 'NATIONAL_ID_INVALID_FORMAT');
});

test('maskNationalId keeps only the last four digits', () => {
  assert.equal(maskNationalId(FAKE_ID), '****9991');
  assert.equal(maskNationalId('12'), '[redacted]');
});

test('migration 015 is idempotent, additive, and has a separate rollback + preflight', async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const up = await read('../../database/migrations/015_employee_identifier_secure_lookup.sql');
  assert.match(up, /information_schema\.COLUMNS/);
  assert.match(up, /information_schema\.TABLE_CONSTRAINTS/);
  assert.match(up, /CREATE TABLE IF NOT EXISTS employee_identifier_secret/);
  assert.match(up, /CREATE TABLE IF NOT EXISTS employee_identifier_access_audit/);
  assert.match(up, /\[0-9a-f\]\{64\}/);
  assert.match(up, /lookup_key_version SMALLINT UNSIGNED NULL/);
  assert.ok(!/DROP\s+(TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE/i.test(up.replace(/^--.*$/gm, '')), 'up migration must be non-destructive');
  const down = await read('../../database/rollbacks/015_employee_identifier_secure_lookup.down.sql');
  assert.match(down, /DROP COLUMN lookup_key_version/);
  const pre = await read('../../database/preflight/015_preflight.sql');
  assert.match(pre, /duplicate_type_value_groups/);
  assert.ok(!/SELECT\s+[^;]*id_value\s*,/i.test(pre.replace(/^--.*$/gm, '')), 'preflight must not select id_value');
});
