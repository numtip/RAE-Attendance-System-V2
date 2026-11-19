const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { runDivisionMembership, parseArgs } = require('../src/imports/divisionMembershipCli');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

function files(rosterLines, mappingLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'div-'));
  const roster = path.join(dir, 'roster.csv');
  const mapping = path.join(dir, 'mapping.csv');
  fs.writeFileSync(roster, `\uFEFFรหัสที่เครื่อง,ชื่อพนักงาน,แผนก\n${rosterLines.join('\n')}\n`);
  fs.writeFileSync(mapping, `employee_id,facescan_id\n${mappingLines.join('\n')}\n`);
  return { roster, mapping };
}

function container(memberships = []) {
  const list = [...memberships];
  const byId = { E1: { employeeUid: A }, E2: { employeeUid: B } };
  return {
    dataSource: 'fixture',
    repositories: {
      employees: { async findByEmployeeId(id) { return byId[id] || null; } },
      authorization: { async listMemberships() { return list; }, async addMembership() { throw new Error('dry run must not write'); } },
    },
  };
}

test('dry run reports counts only and writes nothing', async () => {
  const { roster, mapping } = files(
    ['101,ชื่อ,กองบริหารงานวิจัย', '102,ชื่อ,กองบริหารงานสำนักวิจัยฯ', '103,ชื่อ,กองลึกลับ', '104,ชื่อ,กองบริหารงานวิจัย'],
    ['E1,101', 'E2,102'],
  );
  const { exitCode, report } = await runDivisionMembership(['--roster', roster, '--mapping', mapping], { container: container() });
  assert.equal(exitCode, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.written, false);
  assert.equal(report.toInsert, 2);
  assert.equal(report.unknownDivisionName, 1);
  assert.equal(report.noMapping, 1);
  assert.deepEqual(report.perDivision, { DIV_OFFICE: 1, DIV_RESEARCH: 1, DIV_ACADEMIC_SERVICE: 0 });
  const printed = JSON.stringify(report);
  assert.ok(!printed.includes('101') && !printed.includes(A), 'no id or uid in the output');
});

test('an employee listed in two divisions is ambiguous and a conflicting existing membership is not overwritten', async () => {
  const { roster, mapping } = files(
    ['101,ก,กองบริหารงานวิจัย', '105,ก,กองบริหารงานสำนักวิจัยฯ', '102,ข,กองบริหารงานวิจัย'],
    ['E1,101', 'E1,105', 'E2,102'],
  );
  const { report } = await runDivisionMembership(['--roster', roster, '--mapping', mapping], {
    container: container([{ employeeUid: B, orgUnitCode: 'DIV_OFFICE' }]),
  });
  assert.equal(report.ambiguous, 1);
  assert.equal(report.conflictsWithExisting, 1);
  assert.equal(report.toInsert, 0);
});

test('a repeat is idempotent: an existing identical membership is counted, not inserted', async () => {
  const { roster, mapping } = files(['101,ก,กองบริหารงานวิจัย'], ['E1,101']);
  const { report } = await runDivisionMembership(['--roster', roster, '--mapping', mapping], {
    container: container([{ employeeUid: A, orgUnitCode: 'DIV_RESEARCH' }]),
  });
  assert.equal(report.alreadyMember, 1);
  assert.equal(report.toInsert, 0);
});

test('--confirm needs an operator and the MariaDB source', async () => {
  assert.ok(parseArgs(['--roster', 'a', '--mapping', 'b', '--confirm']).error);
  const { roster, mapping } = files(['101,ก,กองบริหารงานวิจัย'], ['E1,101']);
  const { exitCode, report } = await runDivisionMembership(
    ['--roster', roster, '--mapping', mapping, '--confirm', '--operator', A], { container: container() });
  assert.notEqual(exitCode, 0);
  assert.match(report.refused, /mariadb/);
});
