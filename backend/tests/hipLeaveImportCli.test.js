const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { runHipLeaveImport, parseArgs } = require('../src/imports/hipLeaveImportCli');
const { LeaveRecordRepository } = require('../src/repositories/leaveRecordRepository');

const HEADER = 'รหัสที่เครื่อง,ชื่อพนักงาน,แผนก,วัน/เวลา ,สถานะ,เข้า [1],ออก [1],สาย [1],ออกก่อน [1],Remark [1],\n';
const UID = 'aaaaaaaa-0000-0000-0000-000000000001';

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

function container(leaveRecords = new LeaveRecordRepository()) {
  return {
    dataSource: 'fixture',
    repositories: {
      leaveRecords,
      employeeIdentifiers: {
        async findActiveByTypeAndValue(type, value) { return type === 'facescan_id' && value === '1000' ? { employeeUid: UID } : null; },
      },
      employees: { async findByUid(uid) { return uid === UID ? { employeeUid: UID, status: 'active' } : null; } },
    },
  };
}

const march = `${HEADER}1000,ช,แ,4/3/2569,วันทำงาน,08:29,,,,กิจ,ไม่สแกนออก\n1000,ช,แ,5/3/2569,วันทำงาน,,,,,พักผ่อน,\n9999,ช,แ,5/3/2569,วันทำงาน,,,,,ป่วย,\n`;

test('arguments: dry run by default; --confirm needs --operator', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['x', '--confirm']).error);
  assert.ok(parseArgs(['x', '--operator', 'u']).error);
  assert.ok(!parseArgs(['x']).error);
});

test('two files for one month are refused before anything is read into a write', async () => {
  const dir = dirWith({ 'a.csv': march, 'b.csv': march });
  const { exitCode, report } = await runHipLeaveImport([dir], { container: container() });
  assert.notEqual(exitCode, 0);
  assert.match(report.refused, /same month/);
});

test('dry run reports month counts and writes nothing; output carries no id, uid or date', async () => {
  const repo = new LeaveRecordRepository();
  const dir = dirWith({ 'march.csv': march });
  const { exitCode, report } = await runHipLeaveImport([dir], { container: container(repo) });
  assert.equal(exitCode, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.written, false);
  assert.equal(repo.records.length, 0);
  const [month] = report.months;
  assert.equal(month.period, '2026-03');
  assert.equal(month.candidates, 2);
  assert.equal(month.pm, 1);
  assert.equal(month.full, 1);
  assert.equal(month.days, 1.5);
  assert.equal(month.unmappedRecords, 1, 'an unlinked machine code is counted, not guessed');
  const printed = JSON.stringify(report);
  assert.ok(!printed.includes(UID) && !printed.includes('1000') && !printed.includes('2569'));
});

test('--confirm needs the MariaDB source', async () => {
  const dir = dirWith({ 'march.csv': march });
  const { exitCode, report } = await runHipLeaveImport([dir, '--confirm', '--operator', UID], { container: container() });
  assert.notEqual(exitCode, 0);
  assert.match(report.refused, /mariadb/);
});

test('repository insert is idempotent on (employee, date, part, source)', async () => {
  const repo = new LeaveRecordRepository();
  const rec = { employeeUid: UID, leaveDate: '2026-03-04', leaveType: 'personal', dayPart: 'PM', dayFraction: 0.5, reviewStatus: 'candidate', sourceSystem: 's' };
  assert.equal(await repo.insertIgnore([rec]), 1);
  assert.equal(await repo.insertIgnore([rec]), 0);
  assert.equal(repo.records.length, 1);
  assert.equal(repo.records[0].approvalStatus, 'unverified');
});
