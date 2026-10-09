const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomBytes } = require('node:crypto');
const c = require('../src/security/nationalIdContract');

const b64 = (n) => randomBytes(n).toString('base64');
const FAKE = '9999999999991';
// TEST-ONLY fixed key (32 x 0x01) for the golden vector. Never a real key.
const GOLDEN_KEY = Buffer.alloc(32, 1);

test('canonicalization: strict, Thai digits, separators, no stripping of letters', () => {
  assert.equal(c.canonicalizeNationalId('1-1802-00015-35-1'), '1180200015351');
  assert.equal(c.canonicalizeNationalId(' 1180200015351 '), '1180200015351');
  assert.equal(c.canonicalizeNationalId('๑๑๘๐๒๐๐๐๑๕๓๕๑'), '1180200015351');
  assert.equal(c.canonicalizeNationalId('１１８０２０００１５３５１'), '1180200015351'); // full-width via NFKC
  for (const bad of ['', null, undefined, 'abc', '118020001535', '11802000153511', 'x1180200015351', '1180200015351\n;DROP', '１２'])
    assert.equal(c.canonicalizeNationalId(bad), '', String(bad));
});

test('golden vector freezes the HMAC contract (domain string, separator, id_type, hex)', () => {
  const expected = require('node:crypto')
    .createHmac('sha256', GOLDEN_KEY)
    .update(`rae-attendance-v2:identifier-lookup:v1\0national_id\0${FAKE}`, 'utf8')
    .digest('hex');
  assert.equal(c.identifierLookupHmac('national_id', FAKE, { version: 1, key: GOLDEN_KEY }), expected);
  // Frozen regression vector (synthetic key + synthetic ID). Changing it breaks every stored lookup.
  assert.equal(expected, 'da1b0fd0218b87571c46a39ef08b0138b39414bc0e70688a47ab08e8bb9b50d4');
  assert.notEqual(expected, createHash('sha256').update(FAKE).digest('hex'));
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('protector fails closed when unconfigured and exposes only error codes', () => {
  const p = c.createNationalIdProtector({});
  assert.equal(p.configured, false);
  assert.equal(p.rawStorageEnabled, false);
  assert.throws(() => p.lookupCurrent(FAKE), (e) => e.code.startsWith('NOT_CONFIGURED') && !e.message.includes(FAKE));
});

test('current + previous lookup candidates and key version', () => {
  const prev = b64(32);
  const p = c.createNationalIdProtector({
    EMPLOYEE_IDENTIFIER_HMAC_KEY: b64(32),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '2',
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: prev,
    EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1',
  });
  assert.equal(p.configured, true);
  assert.deepEqual(p.lookupCandidates(FAKE).map((x) => x.key_version), [2, 1]);
  assert.equal(p.lookupCurrent(FAKE).key_version, 2);
  assert.throws(
    () => c.loadIdentifierKeys({ EMPLOYEE_IDENTIFIER_HMAC_KEY: prev, EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '2', EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS: prev, EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION: '1' }),
    { code: 'KEY_PREVIOUS_EQUALS_CURRENT' },
  );
});

test('raw storage disabled by default; enabled only with flag + approval ref; AES-GCM separate key', () => {
  const hmac = b64(32);
  const base = { EMPLOYEE_IDENTIFIER_HMAC_KEY: hmac, EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1', EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: b64(32), EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID: 'enc-1' };
  const off = c.createNationalIdProtector(base);
  assert.equal(off.rawStorageEnabled, false);
  assert.throws(() => off.encryptRaw(FAKE, { necessityApprovalRef: 'A-1' }), (e) => e.message.includes('RAW_STORAGE_DISABLED'));
  const on = c.createNationalIdProtector({ ...base, EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED: 'true' });
  assert.throws(() => on.encryptRaw(FAKE), { code: 'NECESSITY_APPROVAL_REQUIRED' });
  const envelope = on.encryptRaw(FAKE, { necessityApprovalRef: 'APPROVAL-1' });
  assert.equal(on.decryptRaw(envelope), FAKE);
  assert.throws(
    () => c.createNationalIdProtector({ ...base, EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED: 'true', EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: hmac }).keys(),
    (e) => e.message.includes('KEY_REUSE_HMAC_AND_ENCRYPTION'),
  );
});

test('audit events are metadata-only and reject PII-shaped text', () => {
  const ok = c.buildAuditEvent({ action: 'create', actor: 'operator:alice@example.test', reason: 'link:national_id', keyVersion: 1 });
  assert.equal(ok.action, 'create');
  for (const reason of [FAKE, `id ${FAKE}`, 'has;semicolon', '', 'a'.repeat(300)])
    assert.throws(() => c.buildAuditEvent({ action: 'lookup', actor: 'system', reason }), { code: 'AUDIT_TEXT_REJECTED' });
  assert.throws(() => c.buildAuditEvent({ action: 'drop', actor: 'a', reason: 'b' }), { code: 'AUDIT_ACTION_INVALID' });
  assert.equal(Object.keys(ok).some((k) => /national|raw|value|id_value/i.test(k)), false);
});

test('checksum is a separate screening rule, not part of lookup canonicalization', () => {
  assert.equal(c.isValidNationalIdChecksum('1180200015351'), true);
  assert.equal(c.isValidNationalIdChecksum(FAKE), false);
  assert.ok(c.canonicalizeNationalId(FAKE));
});
