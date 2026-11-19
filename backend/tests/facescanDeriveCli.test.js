const test = require('node:test');
const assert = require('node:assert/strict');

const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { runFacescanDerive } = require('../src/imports/facescanDeriveCli');
const { EXIT } = require('../src/imports/facescanImportCli');

const adminUid = '11111111-1111-1111-1111-111111111111';
const staffUid = '22222222-2222-2222-2222-222222222222';

async function build({ grant = true } = {}) {
  const repositories = createFixtureRepositories();
  const findByUid = repositories.employees.findByUid.bind(repositories.employees);
  repositories.employees.findByUid = async (uid) => {
    const employee = await findByUid(uid);
    return employee && uid === adminUid ? { ...employee, role: grant ? 'executive' : 'admin' } : employee;
  };
  repositories.authorization = {
    async grantsFor(uid) {
      return grant && uid === adminUid ? [{ employeeUid: adminUid, role: 'EXECUTIVE', scopeType: 'organization' }] : [];
    },
    async uidsInOrgUnits() { return []; },
  };
  // Two resolved days for the staff employee, one quarantined scan that must never be derived.
  repositories.attendanceEvents.seedResolvedStaging([
    { id: 1, importBatchUid: 'b', sourceEventKey: 'k1', facescanId: 'FS-USER-001', checkTime: '2026-05-04T08:30:00', checkType: 'in', employeeUid: staffUid },
    { id: 2, importBatchUid: 'b', sourceEventKey: 'k2', facescanId: 'FS-USER-001', checkTime: '2026-05-04T16:30:00', checkType: 'out', employeeUid: staffUid },
    { id: 3, importBatchUid: 'b', sourceEventKey: 'k3', facescanId: 'FS-USER-001', checkTime: '2026-05-05T08:40:00', checkType: 'in', employeeUid: staffUid },
    { id: 4, importBatchUid: 'b', sourceEventKey: 'k4', facescanId: 'FS-X', checkTime: '2026-05-05T09:00:00', checkType: 'in', employeeUid: null, resolutionStatus: 'unmapped' },
  ]);
  const staff = await findByUid(staffUid);
  return { repositories, code: staff.employeeId };
}

const run = (argv, repositories, dataSource = 'mariadb') => runFacescanDerive(argv, { container: { dataSource, repositories } });

test('derive: dry run by default counts the resolved days and writes nothing', async () => {
  const { repositories, code } = await build();
  const result = await run(['--employee-id', code], repositories);
  assert.equal(result.exitCode, EXIT.OK);
  assert.deepEqual(result.report, { mode: 'dry-run', written: false, employees: 1, employeeDays: 2 });
  assert.equal((await repositories.attendance.findForEmployee(staffUid)).filter((row) => row.date.startsWith('2026-05')).length, 0);
});

test('derive: --confirm records each resolved day through deriveDay; an unmapped scan creates nothing', async () => {
  const { repositories, code } = await build();
  const result = await run(['--employee-id', code, '--confirm', '--operator', adminUid], repositories);
  assert.equal(result.exitCode, EXIT.OK);
  assert.deepEqual(result.report, { mode: 'derive', written: true, employeeDays: 2, outcomes: { recorded: 2 } });
  const dates = (await repositories.attendance.findForEmployee(staffUid)).map((row) => row.date);
  assert.ok(dates.includes('2026-05-04') && dates.includes('2026-05-05'));
});

test('derive: fails closed on usage, unknown code, fixture data source and missing grant', async () => {
  const { repositories, code } = await build();
  assert.equal((await run([], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['--employee-id', code, '--confirm'], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['--employee-id', code, '--operator', adminUid], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['--employee-id', 'NO-SUCH-CODE'], repositories)).exitCode, EXIT.USAGE);
  assert.equal((await run(['--employee-id', code, '--confirm', '--operator', adminUid], repositories, 'fixture')).exitCode, EXIT.USAGE);
  const noGrant = await build({ grant: false });
  const refused = await run(['--employee-id', noGrant.code, '--confirm', '--operator', adminUid], noGrant.repositories);
  assert.equal(refused.exitCode, EXIT.NOT_AUTHORISED);
  assert.equal((await noGrant.repositories.attendance.findForEmployee(staffUid)).filter((row) => row.date.startsWith('2026-05')).length, 0);
});
