const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { runLeaveHrImport, parseArgs } = require('../src/imports/leaveHrImportCli');
const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { LeaveHrRepository } = require('../src/repositories/leaveHrRepository');
const { PROFILE_COLUMNS: P, ENTITLEMENT_COLUMNS: E } = require('../src/domain/hrLeaveCsv');

const OP = 'op-uid-0000';
const NAMES = ['สมชาย', 'ใจดี', 'สมหญิง', 'รักงาน'];

function setup({ operatorRole = 'executive' } = {}) {
  const rows = [
    { employeeUid: 'u-uni', employeeId: '1001', employeeType: 'university', status: 'active', hireDate: null, firstNameTh: 'สมชาย', lastNameTh: 'ใจดี' },
    { employeeUid: 'u-dep', employeeId: '1002', employeeType: 'department', status: 'active', hireDate: null, firstNameTh: 'สมหญิง', lastNameTh: 'รักงาน' },
    { employeeUid: 'u-con', employeeId: '1003', employeeType: 'contract', status: 'active', hireDate: null, firstNameTh: 'วิชัย', lastNameTh: 'มั่นคง' },
    { employeeUid: 'u-off', employeeId: '1004', employeeType: 'university', status: 'inactive', hireDate: null, firstNameTh: 'นภา', lastNameTh: 'สดใส' },
    { employeeUid: OP, employeeId: '9000', employeeType: 'university', status: 'active', hireDate: '2010-01-01', firstNameTh: 'ผู้', lastNameTh: 'ดูแล', role: operatorRole },
  ];
  const employees = new EmployeeRepository(rows);
  const leaveHr = new LeaveHrRepository({ employees });
  const repositories = {
    employees,
    leaveHr,
    authorization: {
      async grantsFor(uid) { return uid === OP ? [{ scopeType: 'organization', role: 'EXECUTIVE' }] : []; },
      async uidsInOrgUnits() { return []; },
    },
  };
  return { container: { dataSource: 'mariadb', repositories }, employees, leaveHr };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-leave-'));
let counter = 0;
function file(columns, rows, name) {
  const target = path.join(dir, `${name || 'f'}-${counter += 1}.csv`);
  fs.writeFileSync(target, `\uFEFF${Object.values(columns).join(',')}\r\n${rows.map((r) => r.join(',')).join('\r\n')}\r\n`);
  return target;
}
const pRow = (over = {}) => {
  const base = { employeeId: '1001', name: 'นายสมชาย ใจดี', type: 'พนักงานมหาวิทยาลัย', hireDate: '2015-04-01', continuousServiceStart: '2015-04-01', appointmentKind: '', eligibilityConfirmed: '', eligibilityReference: '', sourceReference: 'ทะเบียนประวัติ', note: '', ...over };
  return Object.keys(P).map((k) => base[k]);
};
const eRow = (over = {}) => {
  const base = { employeeId: '1001', fiscalYearBe: '2570', leaveType: 'ลาพักผ่อน', entitlementDays: '10', carryoverDays: '4', usageBaselineDays: '', usageBaselineThrough: '', sourceReference: 'หนังสือ HR', note: '', ...over };
  return Object.keys(E).map((k) => base[k]);
};
const run = (args, ctx) => runLeaveHrImport(args, { container: ctx.container });
const OPERATOR = ['--confirm', '--operator', OP];

test('arguments: a file is needed, --confirm needs an operator and --operator needs --confirm', () => {
  assert.ok(parseArgs([]).error.startsWith('usage:'));
  assert.equal(parseArgs(['--profile']).error, '--profile needs a value');
  assert.equal(parseArgs(['--profile', 'a', '--confirm']).error, '--confirm needs --operator <employee_uid>');
  assert.equal(parseArgs(['--profile', 'a', '--operator', 'x']).error, '--operator is only used with --confirm');
  assert.equal(parseArgs(['--profile', 'a', '--nope']).error, 'unknown option --nope');
  assert.deepEqual(parseArgs(['--profile', 'a', '--entitlement', 'b']).options, { profile: 'a', entitlement: 'b', report: null, confirm: false, operator: null });
});

test('dry run writes nothing, prints counts and rule codes only, and previews the effect', async () => {
  const ctx = setup();
  const report = path.join(dir, 'report-1.csv');
  const f = file(P, [pRow(), pRow({ employeeId: '1002', name: 'นางสาวสมหญิง รักงาน', type: 'พนักงานส่วนงาน', hireDate: '2020-01-01', continuousServiceStart: '2020-01-01' })]);
  const { exitCode, report: out } = await run(['--profile', f, '--report', report], ctx);
  assert.equal(exitCode, 0);
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.written, false);
  assert.equal(out.blockingErrors, 0);
  assert.deepEqual([out.files.profile.rows, out.files.profile.matched, out.files.profile.toApply, out.files.profile.unchanged], [2, 2, 2, 0]);
  assert.deepEqual(out.files.profile.changed, { hire_date: 2, continuous_service_start: 2, source_reference: 2 });
  assert.deepEqual(out.files.profile.warnings, { eligibility_unconfirmed: 1 }); // the department person stays needs_hr

  // nothing was written anywhere
  assert.equal((await ctx.employees.getLeaveFacts('u-uni')).hireDate, null);
  assert.equal(await ctx.leaveHr.getProfile('u-uni'), null);
  assert.deepEqual(ctx.leaveHr.batches, []);

  // the preview shows the gap closing: personal leave was unknown (no hire date), now ok for the university person
  assert.equal(out.preview.people, 2);
  assert.equal(out.preview.before.personal.unknown, 1);
  assert.equal(out.preview.after.personal.ok, 1);
  assert.equal(out.preview.after.personal.needs_hr, 1);

  // no employee id, name, uid or HR value is printed
  const text = JSON.stringify(out) + fs.readFileSync(report, 'utf8');
  for (const secret of ['1001', '1002', ...NAMES, 'u-uni', 'ทะเบียนประวัติ', '2015-04-01']) assert.equal(text.includes(secret), false, secret);
  assert.match(fs.readFileSync(report, 'utf8'), /^kind,line,level,code\nprofile,3,warning,eligibility_unconfirmed\n/);
});

test('blocking findings are reported with exit 3 and block the apply', async () => {
  const ctx = setup();
  const f = file(P, [
    pRow({ employeeId: '7777' }), // not in the registry
    pRow({ employeeId: '1004', name: 'นายนภา สดใส' }), // inactive
    pRow({ employeeId: '1002', name: 'นายสมหญิง รักงาน', type: 'พนักงานมหาวิทยาลัย' }), // registered as department
    pRow({ employeeId: '1003', name: 'นายวิชัย มั่นคง', type: 'พนักงานส่วนงานจ้างเหมา' }), // outsourced, no confirmation
    pRow({ employeeId: '12' }), // malformed id
  ]);
  const dry = await run(['--profile', f], ctx);
  assert.equal(dry.exitCode, 3);
  assert.deepEqual(dry.report.files.profile.errors, { id_format: 1, id_not_found: 1, not_active: 1, type_mismatch: 1, type_out_of_scope: 1 });
  assert.equal(dry.report.blockingErrors, 5);

  const apply = await run([...['--profile', f], ...OPERATOR], ctx);
  assert.equal(apply.exitCode, 3);
  assert.equal(apply.report.written, false);
  assert.deepEqual(ctx.leaveHr.batches, []);
});

test('a file that does not match the template is refused before any row is read', async () => {
  const ctx = setup();
  const bad = path.join(dir, 'bad.csv');
  fs.writeFileSync(bad, 'รหัส,อะไร\n1001,x\n');
  const { exitCode, report } = await run(['--profile', bad], ctx);
  assert.equal(exitCode, 3);
  assert.deepEqual(report.files.profile.fileErrors.sort(), ['missing_column', 'unknown_column']);
  const missing = await run(['--profile', path.join(dir, 'nope.csv')], ctx);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.report.refused, 'the profile file could not be read');
});

test('--confirm needs the MariaDB source and an operator with a data scope; nothing is written otherwise', async () => {
  const f = file(P, [pRow()]);
  const fixture = setup();
  fixture.container.dataSource = 'fixture';
  const a = await run([...['--profile', f], ...OPERATOR], fixture);
  assert.equal(a.exitCode, 2);
  assert.match(a.report.refused, /DATA_SOURCE=mariadb/);

  const plainUser = setup({ operatorRole: 'user' });
  const b = await run([...['--profile', f], ...OPERATOR], plainUser);
  assert.equal(b.exitCode, 4);
  assert.deepEqual(plainUser.leaveHr.batches, []);
  assert.equal((await plainUser.employees.getLeaveFacts('u-uni')).hireDate, null);

  const stranger = setup();
  const c = await run([...['--profile', f, '--confirm', '--operator', 'nobody']], stranger);
  assert.equal(c.exitCode, 4);
});

test('apply: hire date and profile are written with a batch and a field-level audit; the same file again is a no-op', async () => {
  const ctx = setup();
  const f = file(P, [pRow({ appointmentKind: 'อื่น ๆ (เปลี่ยนสถานภาพ/จ้างต่อเนื่อง)' })]);
  const first = await run([...['--profile', f], ...OPERATOR], ctx);
  assert.equal(first.exitCode, 0);
  assert.equal(first.report.written, true);
  assert.deepEqual(first.report.applied.profile, { rowsApplied: 1, rowsUnchanged: 0, auditRows: 4 });

  assert.equal((await ctx.employees.getLeaveFacts('u-uni')).hireDate, '2015-04-01');
  const stored = await ctx.leaveHr.getProfile('u-uni');
  assert.deepEqual([stored.continuousServiceStart, stored.appointmentKind, stored.verifiedByUid, stored.sourceReference], ['2015-04-01', 'other', OP, 'ทะเบียนประวัติ']);
  assert.equal(ctx.leaveHr.batches.length, 1);
  assert.deepEqual(ctx.leaveHr.audit.map((a) => [a.tableName, a.fieldName, a.beforeValue, a.afterValue]).sort(), [
    ['employee_leave_profile', 'appointment_kind', null, 'other'],
    ['employee_leave_profile', 'continuous_service_start', null, '2015-04-01'],
    ['employee_leave_profile', 'source_reference', null, 'ทะเบียนประวัติ'],
    ['employees', 'hire_date', null, '2015-04-01'],
  ]);
  assert.ok(ctx.leaveHr.audit.every((a) => a.actorUid === OP));

  const again = await run([...['--profile', f], ...OPERATOR], ctx);
  assert.equal(again.exitCode, 0);
  assert.equal(again.report.written, false);
  assert.equal(again.report.alreadyApplied, true);
  assert.equal(ctx.leaveHr.batches.length, 1);
  assert.equal(ctx.leaveHr.audit.length, 4);
});

test('a changed file updates only what differs; blank leaves a value, "-" clears it; replacing is a warning', async () => {
  const ctx = setup();
  await run([...['--profile', file(P, [pRow({ appointmentKind: 'บรรจุครั้งแรก' })])], ...OPERATOR], ctx);
  const before = ctx.leaveHr.audit.length;

  const next = file(P, [pRow({ hireDate: '', continuousServiceStart: '2014-01-01', appointmentKind: '-', sourceReference: 'ทะเบียนฉบับใหม่' })]);
  const dry = await run(['--profile', next], ctx);
  assert.equal(dry.report.files.profile.warnings.conflicts_with_existing, 1);
  assert.deepEqual(dry.report.files.profile.changed, { continuous_service_start: 1, appointment_kind: 1, source_reference: 1 });
  const applied = await run([...['--profile', next], ...OPERATOR], ctx);
  assert.equal(applied.exitCode, 0);

  assert.equal((await ctx.employees.getLeaveFacts('u-uni')).hireDate, '2015-04-01'); // blank hire date: untouched
  const stored = await ctx.leaveHr.getProfile('u-uni');
  assert.deepEqual([stored.continuousServiceStart, stored.appointmentKind], ['2014-01-01', null]);
  const added = ctx.leaveHr.audit.slice(before);
  assert.deepEqual(added.map((a) => [a.fieldName, a.beforeValue, a.afterValue]).sort(), [
    ['appointment_kind', 'first', null], ['continuous_service_start', '2015-04-01', '2014-01-01'], ['source_reference', 'ทะเบียนประวัติ', 'ทะเบียนฉบับใหม่'],
  ]);
  assert.equal(ctx.leaveHr.batches.length, 2);
});

test('apply is all or nothing: a failure part-way leaves no hire date, profile, batch or audit behind', async () => {
  const ctx = setup();
  ctx.leaveHr.appendAudit = async () => { throw new Error('audit store down'); };
  const f = file(P, [pRow(), pRow({ employeeId: '1002', name: 'นางสาวสมหญิง รักงาน', type: 'พนักงานส่วนงาน' })]);
  await assert.rejects(() => run([...['--profile', f], ...OPERATOR], ctx), /audit store down/);
  assert.equal((await ctx.employees.getLeaveFacts('u-uni')).hireDate, null);
  assert.equal(await ctx.leaveHr.getProfile('u-uni'), null);
  assert.deepEqual(ctx.leaveHr.batches, []);
  assert.deepEqual(ctx.leaveHr.audit, []);
});

test('entitlements: stored per fiscal year with the batch and operator; warnings for HR-vs-policy and the vacation cap', async () => {
  const ctx = setup();
  const f = file(E, [
    eRow({ carryoverDays: '4', usageBaselineDays: '2', usageBaselineThrough: '2026-11-15' }),
    eRow({ leaveType: 'ลาป่วย', entitlementDays: '90', carryoverDays: '' }), // differs from the policy's 60
    eRow({ employeeId: '1002', carryoverDays: '25' }), // 10 + 25 is over the cap
  ]);
  const dry = await run(['--entitlement', f], ctx);
  assert.equal(dry.exitCode, 0);
  assert.deepEqual(dry.report.files.entitlement.warnings, { differs_from_policy: 1, vacation_cap_exceeded: 1 });
  assert.equal(dry.report.files.entitlement.toApply, 3);
  // a department person with a row is shown as hr_verified in the preview even though the type is unconfirmed
  assert.equal(dry.report.preview.after.vacation.hr_verified, 2);

  const applied = await run([...['--entitlement', f], ...OPERATOR], ctx);
  assert.equal(applied.exitCode, 0);
  const row = await ctx.leaveHr.getEntitlement('u-uni', 2570, 'vacation');
  assert.deepEqual([row.entitlementDays, row.carryoverDays, row.usageBaselineDays, row.usageBaselineThrough, row.verifiedByUid, row.sourceReference],
    [10, 4, 2, '2026-11-15', OP, 'หนังสือ HR']);
  assert.equal((await ctx.leaveHr.getEntitlement('u-uni', 2570, 'sick')).entitlementDays, 90);
  const batch = ctx.leaveHr.batches[0];
  assert.equal(row.importBatchUid, batch.batchUid);
  assert.ok(ctx.leaveHr.audit.some((a) => a.fieldName === 'entitlement_days' && a.entityKey === '2570|sick' && a.afterValue === '90'));
});

test('outsourced staff cannot get an entitlement row unless the same run confirms them with a reference', async () => {
  const blocked = setup();
  const rows = [eRow({ employeeId: '1003', leaveType: 'ลาป่วย', entitlementDays: '60', carryoverDays: '' })];
  const a = await run(['--entitlement', file(E, rows)], blocked);
  assert.deepEqual(a.report.files.entitlement.errors, { type_out_of_scope: 1 });
  assert.equal(a.exitCode, 3);

  const confirmed = setup();
  const profile = file(P, [pRow({ employeeId: '1003', name: 'นายวิชัย มั่นคง', type: 'พนักงานส่วนงานจ้างเหมา', eligibilityConfirmed: 'ใช่', eligibilityReference: 'บันทึก 5/2569' })]);
  const b = await run([...['--profile', profile, '--entitlement', file(E, rows)], ...OPERATOR], confirmed);
  assert.equal(b.exitCode, 0);
  assert.equal(b.report.written, true);
  assert.equal((await confirmed.leaveHr.getEntitlement('u-con', 2570, 'sick')).entitlementDays, 60);
  assert.equal(confirmed.leaveHr.batches.length, 2); // one batch per file, one transaction
});

test('re-importing an entitlement file: identical content is a no-op; blank carry-over keeps the stored one', async () => {
  const ctx = setup();
  await run([...['--entitlement', file(E, [eRow()])], ...OPERATOR], ctx);
  const rewritten = file(E, [eRow({ entitlementDays: '10', carryoverDays: '', sourceReference: 'หนังสือ HR' })]); // same values, different bytes
  const dry = await run(['--entitlement', rewritten], ctx);
  assert.equal(dry.report.files.entitlement.unchanged, 1);
  assert.equal(dry.report.files.entitlement.toApply, 0);
  const applied = await run([...['--entitlement', rewritten], ...OPERATOR], ctx);
  assert.equal(applied.exitCode, 0);
  assert.equal((await ctx.leaveHr.getEntitlement('u-uni', 2570, 'vacation')).carryoverDays, 4); // blank did not erase it
  assert.equal(ctx.leaveHr.audit.length, 3); // entitlement, carry-over and source from the first import; nothing new
  const cleared = await run([...['--entitlement', file(E, [eRow({ carryoverDays: '-' })])], ...OPERATOR], ctx);
  assert.equal(cleared.exitCode, 0);
  assert.equal((await ctx.leaveHr.getEntitlement('u-uni', 2570, 'vacation')).carryoverDays, null);
});
