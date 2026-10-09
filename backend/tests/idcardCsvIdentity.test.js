/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const libPath = pathToFileURL(
  path.join(__dirname, '../../scripts/data-onboarding/idcardCsvLib.mjs'),
).href;

async function loadLib() {
  return import(libPath);
}

function thaiNationalId(first12) {
  const checksum = first12
    .split('')
    .reduce((sum, digit, index) => sum + Number(digit) * (13 - index), 0);
  return `${first12}${(11 - (checksum % 11)) % 10}`;
}

test('maskNationalId never reveals full value', async () => {
  const { maskNationalId } = await loadLib();
  assert.equal(maskNationalId('9900000000001'), '****0001');
  assert.equal(maskNationalId('9900000000001').includes('9900000000001'), false);
});

test('audit classifies exact duplicate rows as SAFE_TO_DEDUPLICATE', async () => {
  const { auditIdCardRows, dedupeExactRows } = await loadLib();
  const nationalA = thaiNationalId('110000000001');
  const nationalB = thaiNationalId('110000000002');
  const rows = [
    { rowNumber: 2, idCardCode: nationalA, facescanCode: '1000', displayName: 'A', orgUnit: 'X' },
    { rowNumber: 3, idCardCode: nationalA, facescanCode: '1000', displayName: 'A', orgUnit: 'X' },
    { rowNumber: 4, idCardCode: nationalB, facescanCode: '1002', displayName: 'B', orgUnit: 'X' },
  ];
  const audit = auditIdCardRows(rows);
  assert.equal(audit.rowCount, 3);
  assert.equal(audit.uniqueNationalIds, 2);
  assert.ok(audit.duplicateCases.some((d) => d.classification === 'A'));
  assert.equal(dedupeExactRows(audit.dedupedRows).length, 2);
});

test('audit flags national_id with different facescan as REQUIRES_HUMAN_REVIEW', async () => {
  const { auditIdCardRows } = await loadLib();
  const national = thaiNationalId('110000000001');
  const rows = [
    { rowNumber: 2, idCardCode: national, facescanCode: '1000', displayName: 'A', orgUnit: 'X' },
    { rowNumber: 3, idCardCode: national, facescanCode: '1001', displayName: 'A2', orgUnit: 'X' },
  ];
  const audit = auditIdCardRows(rows);
  assert.ok(audit.duplicateCases.some((d) => d.classification === 'C'));
});

const { randomBytes } = require('node:crypto');

// Synthetic test-only keys (never real). Contract: see backend/src/security/nationalIdContract.js.
function contractKeys({ version = 1, previous = null } = {}) {
  const env = {
    EMPLOYEE_IDENTIFIER_HMAC_KEY: Buffer.alloc(32, version).toString('base64'),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: String(version),
  };
  if (previous) {
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS = Buffer.alloc(32, previous).toString('base64');
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_PREVIOUS_VERSION = String(previous);
  }
  return env;
}

test('reconcile resolves by protected national_id (HMAC) without name fallback or plaintext lookup', async () => {
  const { loadIdentifierKeys, protectIdentifier, reconcileIdCardToEmployees } = await loadLib();
  const keys = loadIdentifierKeys(contractKeys());
  const national = thaiNationalId('110000000001');
  const uid = '22222222-2222-2222-2222-222222222222';
  const deduped = [{ rowNumber: 2, nationalId: national, facescanId: '1000', orgUnit: 'X' }];
  const identifiers = [{
    employeeUid: uid,
    idType: 'national_id',
    idValue: protectIdentifier('national_id', national, keys).lookupHmac, // what the DB stores post-015
    status: 'active',
  }];
  const result = reconcileIdCardToEmployees(deduped, { employees: [{ employeeUid: uid, status: 'active' }], identifiers }, { keys });
  assert.equal(result.summary.RESOLVED, 1);
  assert.equal(result.items[0].employeeUid, uid);
  assert.throws(() => reconcileIdCardToEmployees(deduped, { identifiers }), /HMAC key is required/);
});

test('plaintext national_id in a snapshot is rejected and never echoed', async () => {
  const { loadIdentifierKeys, reconcileIdCardToEmployees, classifyControlledOnboardingRows } = await loadLib();
  const keys = loadIdentifierKeys(contractKeys());
  const national = thaiNationalId('110000000001');
  const identifiers = [{ employeeUid: 'u', idType: 'national_id', idValue: national, status: 'active' }];
  const rows = [{ rowNumber: 2, nationalId: national, facescanId: '1000' }];
  for (const run of [
    () => reconcileIdCardToEmployees(rows, { identifiers }, { keys }),
    () => classifyControlledOnboardingRows(rows, { identifiers }, { keys }),
  ]) {
    assert.throws(run, (error) => error.message === 'PLAINTEXT_NATIONAL_ID_IN_SNAPSHOT' && !error.message.includes(national));
  }
});

test('controlled onboarding classifies all four outcomes without name/email matching', async () => {
  const { classifyControlledOnboardingRows, loadIdentifierKeys, protectIdentifier } = await loadLib();
  const keys = loadIdentifierKeys(contractKeys());
  const nationals = [1, 2, 3, 4].map((n) => thaiNationalId(`11000000000${n}`));
  const hmac = (value) => protectIdentifier('national_id', value, keys).lookupHmac;
  const uidA = '11111111-1111-4111-8111-111111111111';
  const uidB = '22222222-2222-4222-8222-222222222222';
  const rows = nationals.map((nationalId, index) => ({
    rowNumber: index + 2,
    nationalId,
    facescanId: String(2000 + index),
    displayName: 'must not be matched',
  }));
  const identifiers = [
    { employeeUid: uidA, idType: 'national_id', idValue: hmac(nationals[1]), status: 'active' },
    { employeeUid: uidA, idType: 'facescan_id', idValue: '2001', status: 'active' },
    { employeeUid: uidA, idType: 'national_id', idValue: hmac(nationals[2]), status: 'active' },
    { employeeUid: uidA, idType: 'national_id', idValue: hmac(nationals[3]), status: 'active' },
    { employeeUid: uidB, idType: 'facescan_id', idValue: '2003', status: 'active' },
  ];
  const result = classifyControlledOnboardingRows(rows, { identifiers }, { keys });
  assert.deepEqual(result.counts, { CREATE_CANDIDATE: 1, NOOP: 1, ATTACH_REVIEW: 1, HARD_CONFLICT: 1 });
  assert.equal(result.items[0].employeeUidAction, 'GENERATE_UUID_ON_APPROVED_IMPORT');
  assert.equal(result.items[3].reason, 'IDENTIFIERS_RESOLVE_DIFFERENT_EMPLOYEES');
});

test('secure dry-run stages HMAC + key version only; raw storage disabled; no raw identifiers in report', async () => {
  const { buildControlledOnboardingDryRun, loadIdentifierKeys } = await loadLib();
  const national = thaiNationalId('110000000001');
  const keys = loadIdentifierKeys(contractKeys({ version: 3 }));
  const report = buildControlledOnboardingDryRun([{
    rowNumber: 2,
    idCardCode: national,
    facescanCode: '3001',
    displayName: 'Sensitive Display Name',
    orgUnit: 'Sensitive Org',
  }], {}, keys);
  const [protectedNational, facescan] = report.items[0].identifiers;
  const serialized = JSON.stringify(report);
  assert.equal(report.writesDatabase, false);
  assert.equal(report.classification.CREATE_CANDIDATE, 1);
  assert.equal(protectedNational.lookupHmac.length, 64);
  assert.equal(protectedNational.lookupKeyVersion, 3);
  assert.equal(protectedNational.rawStorage, 'DISABLED');
  assert.equal(protectedNational.encryptedValue, undefined);
  assert.equal(facescan.idValue, undefined);
  for (const secret of [national, '3001', 'Sensitive Display Name', 'Sensitive Org']) {
    assert.equal(serialized.includes(secret), false, 'leak: ' + secret.slice(0, 3));
  }
});

test('canonicalization is the shared contract: strict input, no digit-stripping of arbitrary text', async () => {
  const { normalizeNationalId, protectIdentifier, loadIdentifierKeys } = await loadLib();
  assert.equal(normalizeNationalId('1-1000-00000-01-0'.slice(0, 17)), '1100000000010');
  assert.equal(normalizeNationalId('ID:1100000000010'), '');
  const keys = loadIdentifierKeys(contractKeys());
  assert.throws(() => protectIdentifier('national_id', 'ID:1100000000010', keys), /Invalid national_id/);
});

test('key reuse is rejected by the contract and employee_uid is UUID v4', async () => {
  const { generateEmployeeUid, loadIdentifierKeys } = await loadLib();
  const shared = randomBytes(32).toString('base64');
  assert.throws(
    () => loadIdentifierKeys({
      EMPLOYEE_IDENTIFIER_HMAC_KEY: shared,
      EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1',
      EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED: 'true',
      EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY: shared,
      EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID: 'bad',
    }),
    (error) => error.code === 'KEY_REUSE_HMAC_AND_ENCRYPTION',
  );
  assert.match(generateEmployeeUid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('rotation: snapshot stored under v1 reconciles with current v2 + previous v1; v2-only misses; fails closed without keys', async () => {
  const { classifyControlledOnboardingRows, loadIdentifierKeys, protectIdentifier } = await loadLib();
  const national = thaiNationalId('110000000001');
  const v1 = loadIdentifierKeys(contractKeys({ version: 1 }));
  const rotating = loadIdentifierKeys(contractKeys({ version: 2, previous: 1 }));
  const v2Only = loadIdentifierKeys(contractKeys({ version: 2 }));
  const uid = '33333333-3333-4333-8333-333333333333';
  const identifiers = [
    { employeeUid: uid, idType: 'national_id', lookupHmac: protectIdentifier('national_id', national, v1).lookupHmac, status: 'active' },
    { employeeUid: uid, idType: 'facescan_id', idValue: '3002', status: 'active' },
  ];
  const rows = [{ rowNumber: 2, nationalId: national, facescanId: '3002' }];
  assert.equal(classifyControlledOnboardingRows(rows, { identifiers }, { keys: rotating }).counts.NOOP, 1);
  assert.equal(classifyControlledOnboardingRows(rows, { identifiers }, { keys: v2Only }).counts.NOOP, 0);
  assert.throws(() => classifyControlledOnboardingRows(rows, { identifiers }), /HMAC key is required/);
});

test('CSV cross-mapping ambiguity is a hard conflict', async () => {
  const { classifyControlledOnboardingRows } = await loadLib();
  const national = thaiNationalId('110000000001');
  const result = classifyControlledOnboardingRows([
    { rowNumber: 2, nationalId: national, facescanId: '4001' },
    { rowNumber: 3, nationalId: national, facescanId: '4002' },
  ]);
  assert.equal(result.counts.HARD_CONFLICT, 2);
  assert.ok(result.items.every((item) => item.reason === 'CSV_IDENTIFIER_CONFLICT'));
});
