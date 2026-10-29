/**
 * F9 — national-ID handling through the service layer, using the fixture repositories.
 *
 * Synthetic identities and throwaway keys only. The point of these tests is that the raw national ID never
 * reaches storage, a response, or an error message.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFixtureEmployeeIdentifierRepository } = require('../src/repositories/fixtureEmployeeIdentifierRepository');
const { createEmployeeIdentifierMariaDbRepository } = require('../src/repositories/mariadb/employeeIdentifierMariaDbRepository');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createNationalIdProtector, MIN_KEY_BYTES } = require('../src/security/nationalIdContract');

process.env.DATA_SOURCE = 'fixture';

const KEY_V1 = 'k'.repeat(MIN_KEY_BYTES);
const KEY_V2 = 'm'.repeat(MIN_KEY_BYTES);
const ID_A = '9900000000002';
const ID_B = '9900000000003';

const protector = () => createNationalIdProtector({ keys: { 1: KEY_V1, 2: KEY_V2 } });

function service({ keys = { 1: KEY_V1, 2: KEY_V2 }, protector: explicit = undefined } = {}) {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    service: createEmployeeIdentityService({
      repositories,
      nationalIdProtector: explicit !== undefined ? explicit : createNationalIdProtector({ keys }),
    }),
  };
}

async function firstEmployee(repositories) {
  const rows = await repositories.employees.list();
  assert.ok(rows.length > 0, 'fixture data must contain at least one employee');
  return rows[0];
}

// --- storage -----------------------------------------------------------------------------------------

test('linking a national ID stores the digest, never the raw value', async () => {
  const { service: svc, repositories } = service();
  const employee = await firstEmployee(repositories);

  const result = await svc.linkIdentifier({
    employeeUid: employee.employeeUid,
    idType: 'national_id',
    idValue: ID_A,
  });

  const stored = (await repositories.employeeIdentifiers.listByEmployeeUid(employee.employeeUid)).find((r) => r.idType === 'national_id');
  assert.ok(stored, 'a national_id row must exist');
  assert.match(stored.idValue, /^[0-9a-f]{64}$/, 'the stored value must be a 64-hex digest');
  assert.equal(stored.idValue.includes(ID_A), false, 'the raw value must not appear in storage');
  assert.equal(stored.lookupKeyVersion, 2, 'the write uses the newest key version');
  assert.equal(result.lookupKeyVersion, 2);
});

test('the link response is masked and never echoes the raw value', async () => {
  const { service: svc, repositories } = service();
  const employee = await firstEmployee(repositories);

  const result = await svc.linkIdentifier({
    employeeUid: employee.employeeUid,
    idType: 'national_id',
    idValue: ID_A,
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ID_A), false, 'the response must not contain the raw national ID');
  assert.equal(result.idValueMasked, '****0002');
  assert.equal(result.idValue, undefined, 'no raw idValue field may be returned');
});

test('a national ID cannot be linked as plaintext through the repository directly', async () => {
  const { repositories } = service();
  const employee = await firstEmployee(repositories);

  await assert.rejects(
    () => repositories.employeeIdentifiers.insert({
      employeeUid: employee.employeeUid,
      idType: 'national_id',
      idValue: ID_A,
    }),
    (err) => err.code === 'NATIONAL_ID_MUST_BE_PROTECTED',
    'a raw national ID must be refused at the repository boundary',
  );
});

test('a 64-hex digest without a key version is also refused by the repository', async () => {
  const { repositories } = service();
  const employee = await firstEmployee(repositories);
  await assert.rejects(
    () => repositories.employeeIdentifiers.insert({
      employeeUid: employee.employeeUid,
      idType: 'national_id',
      idValue: 'a'.repeat(64),
    }),
    (err) => err.code === 'NATIONAL_ID_MUST_BE_PROTECTED',
  );
});

// --- resolution --------------------------------------------------------------------------------------

test('a linked national ID resolves back to the employee', async () => {
  const { service: svc, repositories } = service();
  const employee = await firstEmployee(repositories);
  await svc.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });

  const found = await svc.resolve('national_id', ID_A);
  assert.equal(found.employeeUid, employee.employeeUid);
});

test('resolution works across a key rotation (a v1-era row is still found under v2)', async () => {
  const repositories = createFixtureRepositories();
  const employee = await firstEmployee(repositories);

  // Write with v1 only, as an older deployment would have.
  const v1 = createEmployeeIdentityService({
    repositories,
    nationalIdProtector: createNationalIdProtector({ keys: { 1: KEY_V1 } }),
  });
  await v1.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });

  // Now a v2-current deployment must still resolve it.
  const v2 = createEmployeeIdentityService({
    repositories,
    nationalIdProtector: protector(),
  });
  const found = await v2.resolve('national_id', ID_A);
  assert.equal(found.employeeUid, employee.employeeUid);
});

test('an unknown national ID is a 404, not a 500 or an empty success', async () => {
  const { service: svc } = service();
  await assert.rejects(
    () => svc.resolve('national_id', ID_B),
    (err) => err.status === 404 && err.code === 'EMPLOYEE_NOT_FOUND',
  );
});

test('an invalid national ID is rejected before any hashing', async () => {
  const { service: svc } = service();
  for (const bad of ['123', '', 'abcdefghijklm']) {
    await assert.rejects(
      () => svc.resolve('national_id', bad),
      (err) => err.status === 400,
      `${JSON.stringify(bad)} must be a 400`,
    );
  }
});

// --- duplicates and ambiguity ------------------------------------------------------------------------

test('the same national ID cannot be linked to a second employee', async () => {
  const { service: svc, repositories } = service();
  const rows = await repositories.employees.list();
  assert.ok(rows.length >= 2, 'need at least two fixture employees');
  const [a, b] = rows;

  await svc.linkIdentifier({ employeeUid: a.employeeUid, idType: 'national_id', idValue: ID_A });
  await assert.rejects(
    () => svc.linkIdentifier({ employeeUid: b.employeeUid, idType: 'national_id', idValue: ID_A }),
    (err) => err.status === 409,
    'a duplicate identity must be refused, never merged automatically',
  );
});

test('a duplicate is caught ACROSS key versions (the database cannot see this one)', async () => {
  // UNIQUE (id_type, id_value) compares digests, and a digest differs per key version, so a v1-era row and a v2
  // write look different to the database even though they are the same person. Migration 015's header delegates
  // this check to the application; without it, a rotation would let two employees claim one national ID.
  const repositories = createFixtureRepositories();
  const rows = await repositories.employees.list();
  assert.ok(rows.length >= 2);
  const [a, b] = rows;

  const v1 = createEmployeeIdentityService({
    repositories,
    nationalIdProtector: createNationalIdProtector({ keys: { 1: KEY_V1 } }),
  });
  await v1.linkIdentifier({ employeeUid: a.employeeUid, idType: 'national_id', idValue: ID_A });

  const v2 = createEmployeeIdentityService({ repositories, nationalIdProtector: protector() });
  await assert.rejects(
    () => v2.linkIdentifier({ employeeUid: b.employeeUid, idType: 'national_id', idValue: ID_A }),
    (err) => err.status === 409,
    'the same person must not be claimable by a second employee after a rotation',
  );

  // And the original owner re-linking under v2 is idempotent, not a duplicate.
  const again = await v2.linkIdentifier({ employeeUid: a.employeeUid, idType: 'national_id', idValue: ID_A });
  assert.equal(again.lookupKeyVersion, 1, 'the existing row is returned unchanged');
  const stored = await repositories.employeeIdentifiers.listByEmployeeUid(a.employeeUid);
  assert.equal(stored.filter((r) => r.idType === 'national_id').length, 1);
});

test('re-linking the same ID to the same employee is idempotent', async () => {
  const { service: svc, repositories } = service();
  const employee = await firstEmployee(repositories);
  const first = await svc.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });
  const second = await svc.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });
  assert.equal(first.id, second.id, 'a replay must return the same row, not create a new one');
  const rows = (await repositories.employeeIdentifiers.listByEmployeeUid(employee.employeeUid)).filter((r) => r.idType === 'national_id');
  assert.equal(rows.length, 1);
});

// --- fail closed -------------------------------------------------------------------------------------

test('without a protector, national-ID operations fail closed instead of storing plaintext', async () => {
  const { service: svc, repositories } = service({ protector: null });
  const employee = await firstEmployee(repositories);

  await assert.rejects(
    () => svc.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A }),
    (err) => err.status === 503 && err.code === 'NATIONAL_ID_MATCHING_UNAVAILABLE',
  );
  await assert.rejects(
    () => svc.resolve('national_id', ID_A),
    (err) => err.status === 503 && err.code === 'NATIONAL_ID_MATCHING_UNAVAILABLE',
  );
  assert.equal(
    (await repositories.employeeIdentifiers.listByEmployeeUid(employee.employeeUid)).some((r) => r.idType === 'national_id'),
    false,
    'nothing may be written when the protector is absent',
  );
});

// --- other identifier types are untouched -------------------------------------------------------------

test('facescan_id and employee_id keep their existing plaintext behaviour', async () => {
  const { service: svc, repositories } = service({ protector: null });
  const employee = await firstEmployee(repositories);

  const facescan = await svc.linkIdentifier({
    employeeUid: employee.employeeUid,
    idType: 'facescan_id',
    idValue: '9001',
  });
  assert.equal(facescan.lookupKeyVersion, null);

  const stored = (await repositories.employeeIdentifiers.listByEmployeeUid(employee.employeeUid)).find((r) => r.idType === 'facescan_id');
  assert.equal(stored.idValue, '9001', 'a facescan code is not personal data and stays as-is');
});

// --- schema compatibility: with and without migration 015 ---------------------------------------------

/**
 * A pool that behaves like a schema WITHOUT migration 015: any statement naming `lookup_key_version` fails the
 * way MariaDB fails it. `hasLookupKeyVersion: true` models the post-015 schema, so the same test proves the SQL
 * shape in both directions and cannot pass vacuously.
 */
function fakePool({ hasLookupKeyVersion }) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push(sql);
      if (!hasLookupKeyVersion && /lookup_key_version/.test(sql)) {
        const error = new Error("Unknown column 'lookup_key_version' in 'field list'");
        error.code = 'ER_BAD_FIELD_ERROR';
        throw error;
      }
      if (/^\s*insert/i.test(sql)) return [{ insertId: 1 }];
      if (/WHERE id = \?/.test(sql)) {
        return [[{
          id: 1,
          employee_uid: 'u-1',
          id_type: 'facescan_id',
          id_value: params[0],
          source_system: null,
          is_primary: 0,
          status: 'active',
          verified_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }]];
      }
      return [[]]; // lookups find nothing
    },
  };
}

test('without migration 015, a non-national identifier write never names lookup_key_version', async () => {
  const pool = fakePool({ hasLookupKeyVersion: false });
  const repo = createEmployeeIdentifierMariaDbRepository(pool);

  for (const idType of ['facescan_id', 'employee_id', 'personnel_id']) {
    await repo.insert({ employeeUid: 'u-1', idType, idValue: 'X-1' });
  }
  assert.equal(
    pool.statements.some((sql) => /lookup_key_version/.test(sql)),
    false,
    'only a national_id write may depend on migration 015; the previous defect broke every identifier write',
  );
});

test('with migration 015, the national_ID write records its key version', async () => {
  const pool = fakePool({ hasLookupKeyVersion: true });
  const repo = createEmployeeIdentifierMariaDbRepository(pool);
  const linked = await repo.insert({
    employeeUid: 'u-1',
    idType: 'national_id',
    idValue: 'a'.repeat(64),
    lookupKeyVersion: 2,
  });
  assert.equal(linked.lookupKeyVersion, 2);
  assert.equal(pool.statements.some((sql) => /lookup_key_version/.test(sql)), true);
});

test('without migration 015, a national-ID write is a 503, not a raw "Unknown column" error', async () => {
  const pool = fakePool({ hasLookupKeyVersion: false });
  const svc = createEmployeeIdentityService({
    repositories: {
      employees: { async findByUid() { return { employeeUid: 'u-1' }; } },
      employeeIdentifiers: createEmployeeIdentifierMariaDbRepository(pool),
    },
    nationalIdProtector: createNationalIdProtector({ keys: { 1: KEY_V1 } }),
  });

  await assert.rejects(
    () => svc.linkIdentifier({ employeeUid: 'u-1', idType: 'national_id', idValue: ID_A }),
    (err) => err.status === 503 && err.code === 'NATIONAL_ID_STORAGE_NOT_READY',
  );
});

// --- legacy rows and unknown keys ----------------------------------------------------------------------

test('a legacy plaintext national_id row is not matched (there is no plaintext fallback)', async () => {
  // The state migration 015 refuses to run over: a row written by the old code. Lookups are digest-only, so
  // such a row is invisible until it is reindexed — and it is never matched by comparing raw values.
  const legacy = createFixtureEmployeeIdentifierRepository([
    { id: 1, employeeUid: 'u-1', idType: 'national_id', idValue: ID_A, status: 'active' },
  ]);
  const svc = createEmployeeIdentityService({
    repositories: {
      employees: { async findByUid() { return { employeeUid: 'u-1' }; } },
      employeeIdentifiers: legacy,
    },
    nationalIdProtector: protector(),
  });

  await assert.rejects(
    () => svc.resolve('national_id', ID_A),
    (err) => err.status === 404,
    'a raw value must never be compared to a stored plaintext row',
  );
});

test('a row written under an unknown key does not match a different key of the same version', async () => {
  const repositories = createFixtureRepositories();
  const employee = await firstEmployee(repositories);
  await createEmployeeIdentityService({
    repositories,
    nationalIdProtector: createNationalIdProtector({ keys: { 1: KEY_V1 } }),
  }).linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });

  // Same version number, different secret: nothing may match.
  const otherKeyDeploy = createEmployeeIdentityService({
    repositories,
    nationalIdProtector: createNationalIdProtector({ keys: { 1: 'z'.repeat(MIN_KEY_BYTES) } }),
  });
  await assert.rejects(
    () => otherKeyDeploy.resolve('national_id', ID_A),
    (err) => err.status === 404,
  );
});

// --- PII leakage -------------------------------------------------------------------------------------

test('no error message from the national-ID path contains the raw value', async () => {
  const { service: svc, repositories } = service();
  const employee = await firstEmployee(repositories);
  const rows = await repositories.employees.list();
  await svc.linkIdentifier({ employeeUid: employee.employeeUid, idType: 'national_id', idValue: ID_A });

  const other = rows.find((r) => r.employeeUid !== employee.employeeUid);
  if (!other) return;

  try {
    await svc.linkIdentifier({ employeeUid: other.employeeUid, idType: 'national_id', idValue: ID_A });
    assert.fail('expected a duplicate rejection');
  } catch (err) {
    assert.equal(String(err.message).includes(ID_A), false, 'the error must not echo the national ID');
    assert.equal(JSON.stringify(err.details ?? {}).includes(ID_A), false);
  }
});
