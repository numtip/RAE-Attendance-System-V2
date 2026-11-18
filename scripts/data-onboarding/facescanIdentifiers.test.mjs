// facescan_id mapping tool. Synthetic fixtures only (E-ADMIN / E-USER / E-LOCKED from backend/src/dev).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { parseMappingFile, MappingFileError } from './facescanIdentifiers.mjs';
import { runFacescanIdentifiers } from './apply-facescan-identifiers.mjs';

const require = createRequire(import.meta.url);
const { createFixtureRepositories } = require('../../backend/src/repositories/fixtureRepositories.js');
const { createEmployeeIdentityService } = require('../../backend/src/services/employeeIdentityService.js');
const { createFacescanRawIngestionService } = require('../../backend/src/services/facescanRawIngestionService.js');

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const csv = (...lines) => ['employee_id,facescan_id,name', ...lines].join('\n');

function harness(text) {
  const repositories = createFixtureRepositories();
  const run = (...args) => runFacescanIdentifiers(['map.csv', ...args], {
    container: { dataSource: 'mariadb', repositories },
    readFile: async () => Buffer.from(text, 'utf8'),
  });
  const identity = createEmployeeIdentityService({ repositories });
  const ownerOf = async (code) => identity.resolveUid('facescan_id', code).catch(() => null);
  return { repositories, run, ownerOf };
}

test('mapping file: fails closed on the whole file; extra columns are never read', () => {
  const refused = (text, pattern) => assert.throws(() => parseMappingFile(text), (error) => (
    error instanceof MappingFileError && pattern.test(`${error.message} ${JSON.stringify(error.issues)}`)
  ));
  refused('employee_id,code\nE-USER,1', /missing facescan_id/);
  refused(csv('E-USER,,x'), /facescan_id is empty/);
  refused(csv(',FS-1,x'), /employee_id is empty/);
  refused(csv('E-USER,FS-1,x', 'E-USER,FS-2,x'), /employee_id repeats line 2/);
  refused(csv('E-USER,FS-1,x', 'E-ADMIN,FS-1,x'), /facescan_id repeats line 2/);
  refused(csv(), /no mapping rows/);
  const { pairs } = parseMappingFile(csv('E-ADMIN,FS-ADMIN-9,Synthetic Name'));
  assert.equal(JSON.stringify(pairs).includes('Synthetic Name'), false);
});

test('plan: every conflict is detected, nothing is written, and only line numbers are reported', async () => {
  const { run, ownerOf } = harness(csv(
    'E-ADMIN,FS-ADMIN-9,a',
    'E-USER,FS-USER-001,b', // already linked: same employee, same code
    'E-LOCKED,P-USER-001,c', // another employee's personnel_id (017 namespace)
    'E-NOPE,FS-NOPE,d',
  ));
  const result = await run();
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.report.plan.statuses, {
    new: 1, already_linked: 1, CODE_IS_OTHER_EMPLOYEES_PERSONNEL_ID: 1, EMPLOYEE_NOT_FOUND: 1,
  });
  assert.deepEqual(result.report.plan.conflicts.map((conflict) => conflict.line), [4, 5]);
  assert.equal(result.report.written, false);
  assert.equal(await ownerOf('FS-ADMIN-9'), null, 'a plan with conflicts writes nothing, not even the clean rows');
  assert.equal(/FS-|E-ADMIN|E-USER|1111/.test(JSON.stringify(result.report)), false, 'aggregates only');

  const owned = await harness(csv('E-LOCKED,FS-USER-001,x')).run();
  assert.deepEqual(owned.report.plan.statuses, { CODE_OWNED_BY_OTHER_EMPLOYEE: 1 });
  const replace = await harness(csv('E-USER,FS-OTHER,x')).run();
  assert.deepEqual(replace.report.plan.statuses, { EMPLOYEE_HAS_OTHER_FACESCAN_ID: 1 }, 'a code is never replaced');
});

test('gates: dry run by default; --confirm needs --evidence; fixtures are refused', async () => {
  const { run, ownerOf, repositories } = harness(csv('E-ADMIN,FS-ADMIN-9,a'));
  const dry = await run();
  assert.equal(dry.exitCode, 0);
  assert.equal(dry.report.mode, 'dry-run');
  assert.deepEqual(dry.report.plan.statuses, { new: 1 });
  assert.equal(await ownerOf('FS-ADMIN-9'), null);

  assert.equal((await run('--confirm')).exitCode, 2);
  assert.equal((await run('--confirm', '--evidence', '   ')).exitCode, 2);
  assert.equal((await run('--re-resolve')).exitCode, 2);
  const fixture = await runFacescanIdentifiers(['map.csv'], {
    container: { dataSource: 'fixture', repositories },
    readFile: async () => Buffer.from(csv('E-ADMIN,FS-ADMIN-9,a')),
  });
  assert.equal(fixture.exitCode, 2);
});

test('apply: links to the existing employee_uid, replays as already_linked, and re-resolves quarantine', async () => {
  const { run, ownerOf, repositories } = harness(csv('E-ADMIN,FS-ADMIN-9,a', 'E-USER,FS-USER-001,b'));
  // A scan that arrived before its mapping sits in quarantine.
  const ingestion = createFacescanRawIngestionService({ repositories });
  const batch = await ingestion.startBatch({ sourceSystem: 'hip_daily_report' });
  await ingestion.ingestBatch(batch.id, [{ facescanId: 'FS-ADMIN-9', scanDatetime: '2026-11-16 08:30:00', scanType: 'in' }]);
  assert.equal((await repositories.facescanRaw.listUnmapped({})).length, 1);

  const applied = await run('--evidence', 'synthetic device export, sha256:test', '--confirm', '--re-resolve');
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.report));
  assert.deepEqual(applied.report.outcomes, { linked: 1 });
  assert.deepEqual(applied.report.reResolve, { resolved: 1, stillUnmapped: 0 });
  assert.equal(await ownerOf('FS-ADMIN-9'), ADMIN_UID, 'linked to the existing UID, none minted');
  assert.equal((await repositories.employees.findByEmployeeId('E-ADMIN')).employeeUid, ADMIN_UID);

  const replay = await run('--evidence', 'synthetic device export, sha256:test', '--confirm');
  assert.equal(replay.exitCode, 0);
  assert.deepEqual(replay.report.plan.statuses, { already_linked: 2 });
  assert.deepEqual(replay.report.outcomes, {});
  assert.equal(replay.report.written, false);
});
