const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { runEmployeeProfileImport, parseArgs, splitTitle } = require('../src/imports/employeeProfileCli');

const HEADER = 'รหัส,ชื่อ-นามสกุล,ตำแหน่ง,ประเภทบุคลากร,หน่วยงาน,สถานะ,บทบาทในระบบ';

function csv(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), 'p.csv');
  fs.writeFileSync(file, `﻿${HEADER}\n${lines.join('\n')}\n`);
  return file;
}

function container(employees) {
  const writes = [];
  return {
    writes,
    dataSource: 'fixture',
    repositories: {
      employees: {
        async findByEmployeeId(id) { return employees[id] || null; },
        async updateProfile(uid, fields) { writes.push({ uid, fields }); return true; },
      },
    },
  };
}

const base = (over = {}) => ({
  employeeUid: 'u1', firstNameTh: 'เก่า', lastNameTh: 'เดิม', position: 'ตำแหน่งเก่า',
  department: 'หน่วยเก่า', employeeType: 'university', status: 'active', role: 'user', ...over,
});

test('dry run reports counts only and writes nothing', async () => {
  const c = container({ 1000: base() });
  const file = csv(['1000,นายสมชาย ใจดี,นักวิชาการ,พนักงานส่วนงานจ้างเหมา,กองบริหารงานวิจัย,ปฏิบัติงานอยู่,บุคลากร', ',,,,,,']);
  const { exitCode, report } = await runEmployeeProfileImport(['--file', file], { container: c });
  assert.equal(exitCode, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.blankRows, 1);
  assert.equal(report.toUpdate, 1);
  assert.deepEqual(report.changed, { title: 1, name: 0, position: 1, department: 1, employeeType: 1, status: 0, role: 0 });
  assert.equal(c.writes.length, 0);
  const withNames = await runEmployeeProfileImport(['--file', file, '--update-names'], { container: c });
  assert.equal(withNames.report.changed.name, 1);
  assert.ok(!JSON.stringify(report).includes('สมชาย'));
});

test('a current executive/manager role is kept and admin grant needs the explicit flag', async () => {
  const c = container({ 1: base({ role: 'executive' }), 2: base({ employeeUid: 'u2' }) });
  const file = csv([
    '1,นายก ข,ผู้บริหาร,พนักงานมหาวิทยาลัย,กองบริหารงานวิจัย,ปฏิบัติงานอยู่,บุคลากร',
    '2,นายค ง,ผู้ดูแล,พนักงานมหาวิทยาลัย,กองบริหารงานวิจัย,ปฏิบัติงานอยู่,ผู้ดูแลระบบ(System admin)',
  ]);
  const { report } = await runEmployeeProfileImport(['--file', file], { container: c });
  assert.equal(report.roleKept, 1);
  assert.equal(report.adminGrantSkipped, 1);
  assert.equal(report.changed.role, 0);
  const granted = await runEmployeeProfileImport(['--file', file, '--allow-admin-grant'], { container: c });
  assert.equal(granted.report.adminGrantSkipped, 0);
  assert.equal(granted.report.changed.role, 1);
});

test('unknown vocabulary, bad names and missing employees are counted, never guessed', async () => {
  const c = container({ 1: base() });
  const file = csv([
    '1,ชื่อเดียว,ต,พนักงานมหาวิทยาลัย,ห,ปฏิบัติงานอยู่,บุคลากร',
    '2,นายก ข,ต,ประเภทแปลก,ห,ปฏิบัติงานอยู่,บุคลากร',
    '9,นายก ข,ต,พนักงานมหาวิทยาลัย,ห,ปฏิบัติงานอยู่,บุคลากร',
  ]);
  const { report } = await runEmployeeProfileImport(['--file', file], { container: c });
  assert.equal(report.badName, 1);
  assert.equal(report.unknownType, 1);
  assert.equal(report.notInDatabase, 1);
  assert.equal(report.toUpdate, 0);
});

test('--confirm needs an operator and the MariaDB source', async () => {
  assert.ok(parseArgs(['--file', 'x', '--confirm']).error);
  const c = container({});
  const { exitCode, report } = await runEmployeeProfileImport(['--file', csv([]), '--confirm', '--operator', 'u'], { container: c });
  assert.notEqual(exitCode, 0);
  assert.match(report.refused, /MARIADB|mariadb/);
});

test('the title is split off the first name, longest title first', () => {
  assert.deepEqual(splitTitle('นางสาวสมหญิง'), { titleTh: 'นางสาว', firstNameTh: 'สมหญิง' });
  assert.deepEqual(splitTitle('นายสมชาย'), { titleTh: 'นาย', firstNameTh: 'สมชาย' });
  assert.deepEqual(splitTitle('ว่าที่ร้อยตรีสมบัติ'), { titleTh: 'ว่าที่ร้อยตรี', firstNameTh: 'สมบัติ' });
  assert.deepEqual(splitTitle('ดร.สมศรี'), { titleTh: 'ดร.', firstNameTh: 'สมศรี' });
  assert.deepEqual(splitTitle('สมคิด'), { titleTh: null, firstNameTh: 'สมคิด' });
  assert.deepEqual(splitTitle('นาย'), { titleTh: null, firstNameTh: 'นาย' });
});

test('--update-names writes the title-free name and the title separately', async () => {
  const c = container({ 1: base() });
  const file = csv(['1,นางสาวสมหญิง ใจงาม,ต,พนักงานมหาวิทยาลัย,ห,ปฏิบัติงานอยู่,บุคลากร']);
  const { report } = await runEmployeeProfileImport(['--file', file, '--update-names'], { container: c });
  assert.equal(report.changed.title, 1);
  assert.equal(report.changed.name, 1);
});
