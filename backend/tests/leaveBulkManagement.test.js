const test = require('node:test');
const assert = require('node:assert/strict');

const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { LeaveRepository } = require('../src/repositories/leaveRepository');
const { LeaveRecordRepository } = require('../src/repositories/leaveRecordRepository');
const { LeaveHrRepository } = require('../src/repositories/leaveHrRepository');
const { createLeaveBulkManagementService } = require('../src/services/leaveBulkManagementService');
const { createLeaveEntitlementService } = require('../src/services/leaveEntitlementService');
const { createLeaveEntitlementOverviewService } = require('../src/services/leaveEntitlementOverviewService');
const csv = require('../src/domain/hrLeaveCsv');

const EXEC = 'eeeeeeee-0000-0000-0000-00000000000e';
const MGR = 'ffffffff-0000-0000-0000-00000000000f';
const U1 = 'aaaaaaaa-0000-0000-0000-00000000000a'; // university, no hire date
const U2 = 'aaaaaaaa-0000-0000-0000-00000000000b'; // university, hire date known
const D1 = 'bbbbbbbb-0000-0000-0000-00000000000b'; // department
const P1 = 'bbbbbbbb-0000-0000-0000-00000000000c'; // procurement academic
const C1 = 'cccccccc-0000-0000-0000-00000000000c'; // contract
const NOW = () => new Date('2026-11-23T05:00:00Z');
const FY = 2570;
const exec = { employeeUid: EXEC, role: 'executive' };

const emp = (uid, id, type, extra = {}) => ({ employeeUid: uid, employeeId: id, employeeType: type, status: 'active', hireDate: null, firstNameTh: 'ทดสอบ', lastNameTh: `ระบบ${id}`, role: 'user', ...extra });

function build() {
  const employees = new EmployeeRepository([
    emp(EXEC, '1000', 'university', { role: 'executive', hireDate: '2005-01-01' }), emp(MGR, '1001', 'university', { role: 'manager' }),
    emp(U1, '1002', 'university'), emp(U2, '1003', 'university', { hireDate: '2015-04-01' }), emp(D1, '1004', 'department'),
    emp(P1, '1005', 'procurement_academic'), emp(C1, '1006', 'contract'),
  ]);
  const leaveRecords = new LeaveRecordRepository();
  leaveRecords.coverage = ['2026-10', '2026-11'].map((sourcePeriod) => ({ sourceSystem: 'hip', sourcePeriod }));
  const repositories = {
    authorization: {
      async grantsFor(uid) { return uid === EXEC ? [{ scopeType: 'organization', role: 'EXECUTIVE' }] : (uid === MGR ? [{ scopeType: 'org_unit', role: 'MANAGER', orgUnitCode: 'DIV_RESEARCH' }] : []); },
      async uidsInOrgUnits() { return [U1]; }, async listMemberships() { return []; },
    },
    employees, leave: new LeaveRepository([], []), leaveRecords, leaveHr: new LeaveHrRepository({ employees }),
  };
  // `dataSource: 'mariadb'` lets the import's --confirm run; the in-memory repositories have the same transaction contract.
  const container = { repositories, dataSource: 'mariadb', config: { leave: { entitlementEngine: 'on' } }, now: NOW };
  return {
    repositories, service: createLeaveBulkManagementService(container),
    overview: createLeaveEntitlementOverviewService({ repositories, config: container.config, now: NOW }),
    single: createLeaveEntitlementService({ repositories, now: NOW }),
  };
}
const text = (file) => file.buffer.toString('utf8').replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '');
const lines = (file) => text(file).trim().split(/\r?\n/);

test('only an executive with an organization grant may export, import or confirm in bulk', async () => {
  const { service } = build();
  for (const auth of [{ employeeUid: MGR, role: 'manager' }, { employeeUid: U1, role: 'user' }]) {
    await assert.rejects(() => service.exportTemplate(auth, { kind: 'profile' }), (e) => e.status === 403);
    await assert.rejects(() => service.importFiles(auth, { profile: 'x' }), (e) => e.status === 403);
    await assert.rejects(() => service.bulkEligibility(auth, { employeeUids: [D1], confirmed: true }), (e) => e.status === 403);
  }
});

test('profile template: the import\'s own columns, every employment type, current values only', async () => {
  const { service } = build();
  const file = await service.exportTemplate(exec, { kind: 'profile' });
  assert.match(file.contentType, /text\/csv/);
  assert.equal(file.buffer[0], 0xef); // UTF-8 BOM for Excel
  const rows = lines(file);
  assert.deepEqual(rows[0].split(','), Object.values(csv.PROFILE_COLUMNS));
  assert.equal(rows.length - 1, 7); // all 7 people, section contract staff included
  assert.ok(rows.some((r) => r.startsWith('1006,')));
  const u2 = rows.find((r) => r.startsWith('1003,')).split(',');
  assert.equal(u2[3], '2015-04-01');
  assert.equal(rows.find((r) => r.startsWith('1002,')).split(',')[3], ''); // an unknown hire date stays blank, never invented
});

test('entitlement template: three rows per person for the year, blank unless stored; bad years refused; xlsx is a real workbook', async () => {
  const { service, repositories } = build();
  repositories.leaveHr.entitlements.set(`${U2}|${FY}|vacation`, { employeeUid: U2, fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 3, usageBaselineDays: null, usageBaselineThrough: null, sourceReference: 'owner-entry', importBatchUid: 'b', verifiedByUid: EXEC });
  const file = await service.exportTemplate(exec, { kind: 'entitlement', year: FY });
  const rows = lines(file);
  assert.deepEqual(rows[0].split(','), Object.values(csv.ENTITLEMENT_COLUMNS));
  assert.equal(rows.length - 1, 7 * 3);
  const vac = rows.find((r) => r.startsWith('1003,2570,ลาพักผ่อน'));
  assert.deepEqual(vac.split(',').slice(3, 8), ['10', '3', '', '', 'owner-entry']);
  assert.deepEqual(rows.find((r) => r.startsWith('1002,2570,ลาป่วย')).split(',').slice(3, 8), ['', '', '', '', '']);
  for (const year of [2568, 2572, 'abc']) await assert.rejects(() => service.exportTemplate(exec, { kind: 'entitlement', year }), (e) => e.status === 400);
  await assert.rejects(() => service.exportTemplate(exec, { kind: 'other' }), (e) => e.status === 400);
  const xlsx = await service.exportTemplate(exec, { kind: 'profile', format: 'xlsx' });
  assert.equal(xlsx.buffer.slice(0, 2).toString(), 'PK');
  assert.match(xlsx.filename, /\.xlsx$/);
});

test('upload: dry run writes nothing, confirm applies with audit, the same file again is a no-op, an unchanged export is idempotent', async () => {
  const { service, repositories } = build();
  const template = text(await service.exportTemplate(exec, { kind: 'profile' })).trim().split(/\r?\n/);
  const header = template[0].split(',');
  const idx = (name) => header.indexOf(csv.PROFILE_COLUMNS[name]);
  const filled = template.map((line, i) => {
    if (i === 0) return line;
    const cells = line.split(',');
    if (cells[0] === '1002') { cells[idx('hireDate')] = '2016-03-01'; cells[idx('continuousServiceStart')] = '2016-03-01'; cells[idx('appointmentKind')] = 'บรรจุครั้งแรก'; cells[idx('sourceReference')] = 'เอกสารที่ 1/2569'; }
    return cells.join(',');
  }).join('\n');

  const dry = await service.importFiles(exec, { profile: filled });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.written, false);
  assert.equal(dry.blockingErrors, 0);
  assert.equal(dry.files.profile.toApply, 1);
  assert.equal((await repositories.employees.getLeaveFacts(U1)).hireDate, null); // nothing written
  assert.equal(repositories.leaveHr.batches.length, 0);

  const applied = await service.importFiles(exec, { profile: filled, confirm: true });
  assert.equal(applied.written, true);
  assert.equal((await repositories.employees.getLeaveFacts(U1)).hireDate, '2016-03-01');
  assert.ok(repositories.leaveHr.audit.length >= 3 && repositories.leaveHr.audit.every((a) => a.actorUid === EXEC));

  const again = await service.importFiles(exec, { profile: filled, confirm: true });
  assert.equal(again.written, false);
  assert.equal(again.alreadyApplied, true);
  const auditCount = repositories.leaveHr.audit.length;

  // an export of the new state, uploaded unchanged, finds nothing to do
  const reexport = text(await service.exportTemplate(exec, { kind: 'profile' }));
  const noop = await service.importFiles(exec, { profile: reexport });
  assert.equal(noop.files.profile.toApply, 0);
  assert.equal(noop.blockingErrors, 0);
  assert.equal(repositories.leaveHr.audit.length, auditCount);
});

test('upload: validation errors block the confirm and nothing is written; contract rows are accepted', async () => {
  const { service, repositories } = build();
  const c = csv.PROFILE_COLUMNS;
  const head = [c.employeeId, c.name, c.type, c.hireDate, c.continuousServiceStart, c.appointmentKind, c.eligibilityConfirmed, c.eligibilityReference, c.sourceReference, c.note].join(',');
  const file = [head, '1006,ทดสอบ ระบบ1006,พนักงานส่วนงานจ้างเหมา,2018-01-01,,,,,เอกสาร,', '1002,ทดสอบ ระบบ1002,พนักงานมหาวิทยาลัย,2030-13-40,,,,,เอกสาร,'].join('\n');
  const r = await service.importFiles(exec, { profile: file, confirm: true });
  assert.equal(r.written, false);
  assert.equal(r.blockingErrors, 1); // only the impossible date; the contract row is fine (no appointment kind needed)
  assert.ok(!r.findings.some((f) => f.code === 'type_out_of_scope' || f.code === 'appointment_kind_missing'));
  assert.ok(r.findings.some((f) => f.code === 'date_format'));
  assert.equal(repositories.leaveHr.batches.length, 0);
  assert.equal((await repositories.employees.getLeaveFacts(C1)).hireDate, null);
  // a file with the wrong columns is refused as a file
  const wrong = await service.importFiles(exec, { profile: 'a,b\n1,2' });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.findings.some((f) => f.code === 'unknown_column' || f.code === 'missing_column'));
  await assert.rejects(() => service.importFiles(exec, {}), (e) => e.status === 400);
  await assert.rejects(() => service.importFiles(exec, { profile: 'x'.repeat(900001) }), (e) => e.status === 400);
});

test('entitlement upload applies only the rows that carry data; blank template rows are skipped', async () => {
  const { service, repositories } = build();
  const rows = text(await service.exportTemplate(exec, { kind: 'entitlement', year: FY })).trim().split(/\r?\n/);
  const header = rows[0].split(',');
  const col = (n) => header.indexOf(csv.ENTITLEMENT_COLUMNS[n]);
  const filled = rows.map((line, i) => {
    const cells = line.split(',');
    if (i > 0 && cells[0] === '1003' && cells[col('leaveType')] === 'ลาพักผ่อน') { cells[col('entitlementDays')] = '10'; cells[col('carryoverDays')] = '2'; cells[col('sourceReference')] = 'เอกสาร 5'; }
    return cells.join(',');
  }).join('\n');
  const r = await service.importFiles(exec, { entitlement: filled, confirm: true });
  assert.equal(r.blockingErrors, 0);
  assert.equal(r.written, true);
  assert.equal(r.files.entitlement.toApply, 1);
  const stored = await repositories.leaveHr.getEntitlement(U2, FY, 'vacation');
  assert.deepEqual([stored.entitlementDays, stored.carryoverDays, stored.sourceReference], [10, 2, 'เอกสาร 5']);
  assert.equal(await repositories.leaveHr.getEntitlement(U2, FY, 'sick'), null);
});

test('bulk eligibility: confirms section-contract workers with the owner\'s reference, audited; an unknown or duplicate person refuses the whole request', async () => {
  const { service, repositories, overview } = build();
  const before = await overview.overview(exec, { year: FY });
  assert.equal(before.summary.unconfirmed, 1); // the contract worker (procurement is mapped to the university policy)
  const r = await service.bulkEligibility(exec, { employeeUids: [C1], confirmed: true, reference: 'คำสั่ง 12/2569' });
  assert.deepEqual([r.requested, r.changed, r.unchanged, r.failed.length], [1, 1, 0, 0]);
  const after = await overview.overview(exec, { year: FY });
  assert.equal(after.summary.unconfirmed, 0);
  const row = after.rows.find((x) => x.employeeUid === C1);
  assert.deepEqual([row.profile.eligibilityConfirmed, row.profile.eligibilityReference], [true, 'คำสั่ง 12/2569']);
  assert.deepEqual(['sick', 'personal', 'vacation'].map((t) => row.types[t].totalDays), [10, 5, 10]);
  const audits = repositories.leaveHr.audit.filter((a) => a.fieldName === 'eligibility_confirmed');
  assert.equal(audits.length, 1);
  assert.ok(audits.every((a) => a.actorUid === EXEC && a.afterValue === 'true'));
  assert.ok(repositories.leaveHr.audit.some((a) => a.fieldName === 'eligibility_reference' && a.afterValue === 'คำสั่ง 12/2569'));

  const repeat = await service.bulkEligibility(exec, { employeeUids: [C1], confirmed: true, reference: 'คำสั่ง 12/2569' });
  assert.deepEqual([repeat.changed, repeat.unchanged], [0, 1]);

  const writes = repositories.leaveHr.audit.length;
  for (const body of [
    { employeeUids: ['nobody'], confirmed: true }, { employeeUids: [], confirmed: true },
    { employeeUids: [U1, U1], confirmed: true }, { employeeUids: [U1], confirmed: 'yes' },
  ]) await assert.rejects(() => service.bulkEligibility(exec, body), (e) => e.status === 400);
  assert.equal(repositories.leaveHr.audit.length, writes); // refused before anything was written
  assert.equal((await repositories.leaveHr.getProfile(U1)), null);

  // procurement_academic follows the university policy: no flag, and an explicit decline still works
  const procurement = await service.bulkEligibility(exec, { employeeUids: [P1], confirmed: true });
  assert.equal(procurement.changed, 1);
  const mapped = (await overview.overview(exec, { year: FY })).rows.find((x) => x.employeeUid === P1);
  assert.ok(!mapped.types.sick.flags.includes('policy_assumed_university'));
  assert.equal(mapped.policy.family, 'university');
  const declined = await service.bulkEligibility(exec, { employeeUids: [P1], confirmed: false, reference: 'ไม่อยู่ในหลักเกณฑ์' });
  assert.equal(declined.changed, 1);
  const cleared = await service.bulkEligibility(exec, { employeeUids: [C1], confirmed: null });
  assert.equal(cleared.changed, 1);
  assert.equal((await overview.overview(exec, { year: FY })).summary.unconfirmed, 1);
});

test('the owner entry refuses a carry-over for a section policy and accepts a hire date for contract staff', async () => {
  const { repositories } = build();
  const { createLeaveOwnerEntryService } = require('../src/services/leaveOwnerEntryService');
  const owner = createLeaveOwnerEntryService({ repositories, now: NOW });
  await assert.rejects(() => owner.apply(exec, C1, { entitlements: [{ fiscalYearBe: FY, leaveType: 'vacation', entitlementDays: 10, carryoverDays: 1 }] }), (e) => e.status === 400);
  const ok = await owner.apply(exec, C1, { hireDate: '2018-01-01' });
  assert.equal(ok.changed, 1); // a hire date is optional for contract staff but accepted
});
