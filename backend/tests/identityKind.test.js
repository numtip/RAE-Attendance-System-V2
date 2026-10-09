const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATA_SOURCE = 'fixture';

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createNationalIdProtector } = require('../src/security/nationalIdContract');
const {
  IDENTITY_KIND,
  MJU_PERSONNEL_SOURCE,
  HIP_BATCH_SOURCE,
  deriveIdentityKind,
  ssoPolicyForKind,
} = require('../src/domain/identityKind');

// Synthetic ids only. Two distinct employee uids that exist in the fixture employees.
const MJU_UID = '11111111-1111-1111-1111-111111111111';
const HIP_UID = '22222222-2222-2222-2222-222222222222';

function createService() {
  const nationalId = createNationalIdProtector({
    EMPLOYEE_IDENTIFIER_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
    EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1',
  });
  // Start from an empty identifier table so only the rows created by each test exist.
  const repositories = createFixtureRepositories({ nationalId, identifiers: [] });
  return { service: createEmployeeIdentityService({ repositories }), repositories };
}

test('deriveIdentityKind: MJU needs an MJU-sourced personnel_id; HIP needs the approved batch facescan and no personnel_id', () => {
  assert.equal(deriveIdentityKind([{ idType: 'personnel_id', sourceSystem: MJU_PERSONNEL_SOURCE }]).kind, IDENTITY_KIND.MJU);
  assert.equal(deriveIdentityKind([
    { idType: 'personnel_id', sourceSystem: MJU_PERSONNEL_SOURCE },
    { idType: 'facescan_id', sourceSystem: HIP_BATCH_SOURCE },
  ]).kind, IDENTITY_KIND.MJU);
  assert.equal(deriveIdentityKind([{ idType: 'facescan_id', sourceSystem: HIP_BATCH_SOURCE }]).kind, IDENTITY_KIND.HIP);
  // legacy / unknown source never counts as HIP
  assert.equal(deriveIdentityKind([{ idType: 'facescan_id', sourceSystem: null }]).kind, IDENTITY_KIND.UNRESOLVED);
  assert.equal(deriveIdentityKind([]).kind, IDENTITY_KIND.UNRESOLVED);
  // inactive rows are ignored
  assert.equal(deriveIdentityKind([{ idType: 'personnel_id', sourceSystem: MJU_PERSONNEL_SOURCE, status: 'inactive' }]).kind, IDENTITY_KIND.UNRESOLVED);
});

test('deriveIdentityKind flags a synthetic personnel_id instead of trusting it', () => {
  const result = deriveIdentityKind([
    { idType: 'personnel_id', sourceSystem: 'IDCardRaecsv2027' },
    { idType: 'facescan_id', sourceSystem: HIP_BATCH_SOURCE },
  ]);
  assert.equal(result.kind, IDENTITY_KIND.UNRESOLVED);
  assert.deepEqual(result.violations, ['PERSONNEL_ID_NOT_FROM_MJU']);
});

test('SSO policy: never required, never creates a subject', () => {
  for (const kind of Object.values(IDENTITY_KIND)) {
    const policy = ssoPolicyForKind(kind);
    assert.equal(policy.required, false);
    assert.equal(policy.createSubject, false);
  }
  assert.equal(ssoPolicyForKind(IDENTITY_KIND.UNRESOLVED).linkAllowedFrom, 'none');
});

test('service: personnel_id can only be linked from the MJU source (no fake personnel_id for contractors)', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.linkIdentifier({ employeeUid: HIP_UID, idType: 'personnel_id', idValue: '1234', sourceSystem: HIP_BATCH_SOURCE }),
    (error) => error.status === 400 && error.code === 'PERSONNEL_ID_SOURCE_REQUIRED',
  );
  await assert.rejects(
    () => service.linkIdentifier({ employeeUid: HIP_UID, idType: 'personnel_id', idValue: '1234' }),
    (error) => error.code === 'PERSONNEL_ID_SOURCE_REQUIRED',
  );
  await service.linkIdentifier({ employeeUid: MJU_UID, idType: 'personnel_id', idValue: 'P-900001', sourceSystem: MJU_PERSONNEL_SOURCE });
});

test('service: HIP vs MJU kind and same-value namespace collision across employees', async () => {
  const { service } = createService();
  await service.linkIdentifier({ employeeUid: MJU_UID, idType: 'personnel_id', idValue: '5001', sourceSystem: MJU_PERSONNEL_SOURCE });
  await service.linkIdentifier({ employeeUid: HIP_UID, idType: 'facescan_id', idValue: '7001', sourceSystem: HIP_BATCH_SOURCE });

  assert.equal((await service.getIdentityKind(MJU_UID)).kind, 'MJU');
  const hip = await service.getIdentityKind(HIP_UID);
  assert.equal(hip.kind, 'HIP');
  assert.equal(hip.sso.required, false);
  assert.equal(hip.sso.createSubject, false);

  // Same text in the other namespace for a DIFFERENT employee is refused (either direction).
  await assert.rejects(
    () => service.linkIdentifier({ employeeUid: HIP_UID, idType: 'facescan_id', idValue: '5001', sourceSystem: HIP_BATCH_SOURCE }),
    (error) => error.status === 409 && error.code === 'IDENTIFIER_NAMESPACE_COLLISION',
  );
  await assert.rejects(
    () => service.linkIdentifier({ employeeUid: MJU_UID, idType: 'personnel_id', idValue: '7001', sourceSystem: MJU_PERSONNEL_SOURCE }),
    (error) => error.code === 'IDENTIFIER_NAMESPACE_COLLISION',
  );
  // The SAME employee may legitimately hold equal text in both namespaces (e.g. HIP device id == personnel id).
  await service.linkIdentifier({ employeeUid: MJU_UID, idType: 'facescan_id', idValue: '5001', sourceSystem: HIP_BATCH_SOURCE });
  // Resolution stays typed: the HIP value never resolves as a personnel_id of someone else.
  assert.equal((await service.resolve('facescan_id', '7001')).employeeUid, HIP_UID);
  await assert.rejects(() => service.resolve('personnel_id', '7001'), (error) => error.status === 404);
});

test('service: HIP contractor can later upgrade to MJU by attaching an MJU personnel_id to the same employee_uid', async () => {
  const { service } = createService();
  await service.linkIdentifier({ employeeUid: HIP_UID, idType: 'facescan_id', idValue: '7002', sourceSystem: HIP_BATCH_SOURCE });
  assert.equal((await service.getIdentityKind(HIP_UID)).kind, 'HIP');
  await service.linkIdentifier({ employeeUid: HIP_UID, idType: 'personnel_id', idValue: 'P-900002', sourceSystem: MJU_PERSONNEL_SOURCE });
  assert.equal((await service.getIdentityKind(HIP_UID)).kind, 'MJU');
  // facescan_id stays the attendance source for the same employee
  assert.equal((await service.resolve('facescan_id', '7002')).employeeUid, HIP_UID);
});
