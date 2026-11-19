const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createOrganizationReportService } = require('../src/services/organizationReportService');

const operatorUid = '11111111-1111-1111-1111-111111111111'; // fixture E-ADMIN
const staffUid = '22222222-2222-2222-2222-222222222222'; // fixture E-USER (has March 2026 totals)

function build({ role, grants = [], members = [] }) {
  const repositories = createFixtureRepositories();
  repositories.authorization = {
    async grantsFor(uid) { return uid === operatorUid ? grants : []; },
    async uidsInOrgUnits() { return members; },
  };
  return { service: createOrganizationReportService({ repositories }), auth: { role, employeeUid: operatorUid } };
}
const ORG = [{ employeeUid: operatorUid, role: 'EXECUTIVE', scopeType: 'organization' }];
const TEAM = [{ employeeUid: operatorUid, role: 'MANAGER', scopeType: 'org_unit', orgUnitCode: 'U1' }];

function pdfMappedText(buffer) {
  return [...buffer.toString('latin1').matchAll(/<([0-9a-fA-F]{4})>/g)]
    .map((match) => String.fromCharCode(Number.parseInt(match[1], 16)))
    .join('');
}

function xlsxText(buffer) {
  const parts = [];
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(offset + 26);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const dataStart = offset + 30 + nameLength;
    parts.push(zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)).toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return parts.join('\n');
}

test('organization report: EMPLOYEE, a bare ADMIN and a manager without a grant are refused', async () => {
  for (const role of ['user', 'admin', 'manager']) {
    const { service, auth } = build({ role });
    await assert.rejects(service.organization(auth, { year: '2026', month: '3' }), (error) => error.status === 403, role);
    await assert.rejects(service.export(auth, { year: '2026', month: '3', format: 'xlsx' }), (error) => error.status === 403, role);
  }
});

test('organization report: an organization executive sees every employee with stored totals only', async () => {
  const { service, auth } = build({ role: 'executive', grants: ORG });
  const report = await service.organization(auth, { year: '2026', month: '3' });
  assert.equal(report.scope, 'organization');
  assert.equal(report.periodStart, '2026-03-01');
  assert.equal(report.totals.employeesInScope, report.rows.length);
  assert.ok(report.rows.length >= 2);
  const staff = report.rows.find((row) => row.employeeId === 'E-USER');
  assert.equal(staff.present, 20);
  assert.equal(staff.workDays, 22);
  assert.equal(staff.absent, null, 'absence is policy-pending, never derived');
  assert.equal(report.totals.absent, null);
  assert.equal(report.totals.present, report.rows.filter((row) => row.hasMonthlySummary).reduce((sum, row) => sum + row.present, 0));
  assert.match(report.notices.holidayNote, /ไม่หักวันหยุด/);
  assert.equal(report.notices.absenceNote, undefined);
  // A month with no stored summary is reported as missing, not as zeros.
  const january = await service.organization(auth, { year: '2026', month: '1' });
  assert.ok(january.rows.every((row) => row.present === null || row.hasMonthlySummary));
  assert.equal(january.totals.employeesWithoutData + january.totals.employeesWithData, january.totals.employeesInScope);
});

test('organization report: a manager sees only the granted unit', async () => {
  const { service, auth } = build({ role: 'manager', grants: TEAM, members: [staffUid] });
  const report = await service.organization(auth, { year: '2026', month: '3' });
  assert.equal(report.scope, 'team');
  const ids = report.rows.map((row) => row.employeeId).sort();
  assert.deepEqual(ids, ['E-ADMIN', 'E-USER'].filter((id) => ids.includes(id)));
  assert.ok(!ids.includes('E-LOCKED'), 'an employee outside the unit is never listed');
  assert.ok(ids.includes('E-USER'));
});

test('organization report: invalid period and format are rejected', async () => {
  const { service, auth } = build({ role: 'executive', grants: ORG });
  await assert.rejects(service.organization(auth, { year: '1999', month: '3' }), (error) => error.status === 400);
  await assert.rejects(service.organization(auth, { year: '2026', month: '13' }), (error) => error.status === 400);
  await assert.rejects(service.export(auth, { year: '2026', month: '3', format: 'csv' }), (error) => error.code === 'EXPORT_INVALID_FORMAT');
});

test('organization export: PDF and XLSX are real files carrying the same totals and the absence notice', async () => {
  const { service, auth } = build({ role: 'executive', grants: ORG });
  const report = await service.organization(auth, { year: '2026', month: '3' });
  const pdf = await service.export(auth, { year: '2026', month: '3', format: 'pdf' });
  assert.equal(pdf.contentType, 'application/pdf');
  assert.equal(pdf.filename, 'attendance-organization-2569-03.pdf');
  assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.buffer.includes(Buffer.from('Sarabun')));
  const pdfText = pdfMappedText(pdf.buffer);
  // pdfkit subsets glyphs, so extracted text is lossy (repeated glyphs collapse): assert fragments, as reports.test.js does.
  assert.ok(pdfText.includes('E-ADMIN'));
  assert.match(pdfText, /USR/);
  assert.ok(pdfText.includes('2569'));
  assert.match(pdfText, /รายงน/);
  assert.ok(!pdfText.includes('กักกัน'));

  const xlsx = await service.export(auth, { year: '2026', month: '3', format: 'xlsx' });
  assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK');
  assert.equal(xlsx.filename, 'attendance-organization-2569-03.xlsx');
  const xml = xlsxText(xlsx.buffer);
  assert.ok(xml.includes('E-USER'));
  assert.ok(!xml.includes('ยังไม่คำนวณ') && !xml.includes('ขาด'), 'no absence column or notice in the export');
  assert.ok(!xml.includes('ไม่นำเข้า 19 รหัส'));
  assert.ok(xml.includes(`<v>${report.totals.employeesInScope}</v>`));
});

async function call(port, path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}

test('organization report routes: 401 without a session, 403 for a plain employee', async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal((await call(port, '/api/v1/reports/organization?year=2026&month=3')).status, 401);
    assert.equal((await call(port, '/api/v1/reports/organization/export?year=2026&month=3&format=pdf')).status, 401);
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'valid-pass' }),
    });
    const token = (await login.json()).data.accessToken;
    const denied = await call(port, '/api/v1/reports/organization?year=2026&month=3', token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});
