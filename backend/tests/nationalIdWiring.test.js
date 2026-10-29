/**
 * The national-ID protector must REACH the services that need it, and a malformed key set must be visible
 * at boot.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `container.js` built a protector that no call site passed on: both callers of
 * `createEmployeeIdentityService` used `{ repositories }` only. The crypto was correct and the tests were
 * green, but in the assembled app every national-ID operation answered 503
 * `NATIONAL_ID_MATCHING_UNAVAILABLE` even with a valid key configured — a misconfiguration symptom, not a
 * policy choice. Nothing caught it because nothing asserted the pass-through.
 *
 * The services destructure `createEmployeeIdentityService` when they load, so the module is patched BEFORE
 * they are required. The assertions then check the deps the identity service actually receives, which means
 * dropping the argument fails here. No database, no real key.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Same idiom as the other MariaDB/DB-gated suites: resolve from a module, not `__dirname`.
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');

// Patch first: the two services below capture this binding at require time.
const identityModule = require('../src/services/employeeIdentityService');
let seen = null;
identityModule.createEmployeeIdentityService = (deps) => {
  seen = deps;
  return { resolveUid: async () => 'uid-from-stub' };
};

const { resolveEmployeeUidFromBusinessId } = require('../src/services/attendanceComputeService');
const { createFacescanRawIngestionService } = require('../src/services/facescanRawIngestionService');

test('the compute path hands the protector to the identity service', async () => {
  const protector = { writeVersion: 1, acceptVersions: [1], marker: 'compute' };
  seen = null;
  const uid = await resolveEmployeeUidFromBusinessId({ employees: {} }, '9001', protector);
  assert.equal(uid, 'uid-from-stub');
  // Without the pass-through this is `null`, which is exactly the defect: a silent 503 for every national ID.
  assert.equal(seen.nationalIdProtector, protector);
});

test('the compute path still works with no protector, and passes null rather than dropping the key', async () => {
  seen = null;
  await resolveEmployeeUidFromBusinessId({ employees: {} }, '9002');
  assert.equal(seen.nationalIdProtector, null);
  assert.equal('nationalIdProtector' in seen, true);
});

test('the facescan ingestion path hands the protector to the identity service', () => {
  const protector = { writeVersion: 2, acceptVersions: [1, 2], marker: 'facescan' };
  seen = null;
  createFacescanRawIngestionService({ repositories: { facescanRaw: {} }, nationalIdProtector: protector });
  assert.equal(seen.nationalIdProtector, protector);
});

test('a malformed key set is announced at boot with a code, and never with key material', () => {
  const child = spawnSync(
    process.execPath,
    ['-e', `
      const { buildNationalIdProtector } = require('./src/container');
      const protector = buildNationalIdProtector({ NATIONAL_ID_HMAC_KEYS: '1:short-but-secret' });
      process.stdout.write('protectorIsNull=' + (protector === null));
    `],
    { cwd: backendRoot, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.includes('protectorIsNull=true'), true);
  // The warning names the failure by CODE so "misconfigured" cannot look like "feature off"...
  assert.match(child.stderr, /national-id: matching disabled \(NATIONAL_ID_KEY_[A-Z_]+\)/);
  // ...and the key value itself never appears.
  assert.equal(child.stderr.includes('short-but-secret'), false);
  assert.equal(child.stdout.includes('short-but-secret'), false);
});
