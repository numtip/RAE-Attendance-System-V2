import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildLookup,
  buildLookupCandidates,
  detectCrossVersionDuplicates,
  planReindex,
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
    EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED: 'true',
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
  // enabled but key missing => fail closed at load time\r
  assert.throws(() => loadIdentifierKeys({ ...env(), EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: '' }), /KEY_MISSING/);
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
  assert.match(up, /ABORT_015_requires_MariaDB_10_2_3_or_MySQL_8_0_16/);
  assert.match(up, /uk_employee_identifier_national_owner/);
  assert.ok(!/DROP\s+(TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE/i.test(up.replace(/^--.*$/gm, '')), 'up migration must be non-destructive');
  const down = await read('../../database/rollbacks/015_employee_identifier_secure_lookup.down.sql');
  const downSql = down.replace(/^--.*$/gm, '');
  assert.match(downSql, /DROP COLUMN national_id_owner_uid/);
  assert.match(downSql, /ABORT_rollback_secret_rows_exist_export_first/);
  assert.ok(!/DROP COLUMN lookup_key_version/.test(downSql), 'rollback must keep key-version metadata');
  assert.ok(!/employee_identifier_access_audit/.test(downSql), 'rollback must never touch the audit table');
  const pre = await read('../../database/preflight/015_preflight.sql');
  assert.match(pre, /duplicate_type_value_groups/);
  assert.ok(!/SELECT\s+[^;]*id_value\s*,/i.test(pre.replace(/^--.*$/gm, '')), 'preflight must not select id_value');
});

test('raw National ID storage is disabled by default (no flag => no encryption key loaded, encrypt refused)', () => {
  const base = env();
  delete base.EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED;
  const keys = loadIdentifierKeys(base); // key present in env but flag absent
  assert.equal(keys.rawStorageEnabled, false);
  assert.equal(keys.encryption, null);
  assert.throws(
    () => encryptRawIdentifier('national_id', FAKE_ID, keys, { necessityApprovalRef: 'APPROVAL-TEST' }),
    { code: 'RAW_STORAGE_DISABLED' },
  );
  assert.equal(loadIdentifierKeys(env({ EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED: 'yes' })).rawStorageEnabled, false);
});

test('cross-version duplicate detection and reindex planning (pure, no raw output)', () => {
  const k1 = env({ EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1' });
  const keys1 = loadIdentifierKeys(k1);
  const rotating = loadIdentifierKeys({
    ...k1,
    EMPLOYEE_IDENTIFIER_HMAC_KEY: b64(32),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '2',
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: k1.EMPLOYEE_IDENTIFIER_HMAC_KEY,
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1',
  });
  const existing = [
    { id: 1, employee_uid: 'u1', id_value: buildLookup('national_id', FAKE_ID, keys1).lookup_hmac, lookup_key_version: 1 },
    { id: 2, employee_uid: 'u2', id_value: '9999999999992', lookup_key_version: null }, // legacy plaintext
  ];
  const hits = detectCrossVersionDuplicates(
    [{ ref: 'a', raw: FAKE_ID }, { ref: 'b', raw: '9999999999992' }, { ref: 'c', raw: '9999999999993' }],
    existing,
    rotating,
  );
  assert.deepEqual(hits.map((h) => [h.ref, h.existing_key_version, h.legacy_plaintext]), [['a', 1, false], ['b', null, true]]);
  assert.ok(!JSON.stringify(hits).includes(FAKE_ID));

  const plan = planReindex(existing, rotating, { resolveRaw: (row) => (row.id === 1 ? FAKE_ID : null) });
  assert.equal(plan.ok, true); // row 2 is legacy plaintext => its own raw
  assert.deepEqual(plan.updates.map((u) => [u.id, u.from_version, u.to_version]), [[1, 1, 2], [2, null, 2]]);
  assert.ok(!JSON.stringify(plan).includes('9999999999992'));
  assert.equal(planReindex(existing, rotating).ok, false); // row 1 unresolved => not ok, nothing guessed
});