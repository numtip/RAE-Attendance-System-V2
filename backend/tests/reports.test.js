const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');

const userUid = '22222222-2222-2222-2222-222222222222';
const adminUid = '11111111-1111-1111-1111-111111111111';

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function login(port, email) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'valid-pass' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body.data.accessToken;
}

async function getJson(port, path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function getFile(port, path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

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
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength;
    parts.push(zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)).toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return parts.join('\n');
}

test('personal report is self-only and does not invent a missing month', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const anon = await getJson(port, '/api/v1/reports/personal?year=2026&month=3');
    assert.equal(anon.status, 401);

    const user = await login(port, 'user@example.test');
    const admin = await login(port, 'admin@example.test');

    const other = await getJson(port, `/api/v1/reports/personal?year=2026&month=3&employeeUid=${adminUid}`, user);
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'FORBIDDEN');

    const byCode = await getJson(port, '/api/v1/reports/personal?year=2026&month=3&employeeId=E-ADMIN', user);
    assert.equal(byCode.status, 403);

    const report = await getJson(port, `/api/v1/reports/personal?year=2026&month=3&employeeUid=${userUid}`, user);
    assert.equal(report.status, 200);
    assert.equal(report.body.data.employeeUid, userUid);
    assert.equal(report.body.data.employeeId, 'E-USER');
    assert.equal(report.body.data.employeeName, 'ผู้ใช้ ตัวอย่าง');
    assert.equal(report.body.data.buddhistYear, 2569);
    assert.equal(report.body.data.periodStart, '2026-03-01');
    assert.equal(report.body.data.periodEnd, '2026-03-31');
    assert.equal(report.body.data.periodLabel, '1 มีนาคม 2569 – 31 มีนาคม 2569');
    assert.equal(report.body.data.empty, false);
    assert.equal(report.body.data.present, 20);
    assert.equal(report.body.data.workDays, 22);
    assert.equal(report.body.data.late, 1);
    assert.equal(report.body.data.absent, 0);
    assert.equal(report.body.data.leaveDaysOnSummary, 1);
    assert.equal(report.body.data.remainingLeaveDays, 5);
    assert.equal(report.body.data.scans.length, 1);
    assert.equal(report.body.data.scans[0].date, '2026-03-02');
    assert.equal(report.body.data.scans[0].checkInLabel, '08:35');
    assert.equal(report.body.data.scans[0].checkOutLabel, '16:30');
    assert.equal(report.body.data.scans[0].statusLabel, 'สาย');
    assert.equal(report.body.data.leaveRows.length, 1);
    assert.equal(report.body.data.leaveRows[0].typeLabel, 'ลากิจ');

    const empty = await getJson(port, '/api/v1/reports/personal?year=2026&month=1', user);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.empty, true);
    assert.equal(empty.body.data.present, null);
    assert.equal(empty.body.data.scans.length, 0);
    assert.equal(empty.body.data.leaveRows.length, 0);

    const adminEmpty = await getJson(port, '/api/v1/reports/personal?year=2026&month=3', admin);
    assert.equal(adminEmpty.status, 200);
    assert.equal(adminEmpty.body.data.employeeUid, adminUid);
    assert.equal(adminEmpty.body.data.empty, true);
    assert.equal(adminEmpty.body.data.present, null);
  } finally {
    server.close();
  }
});

test('personal export renders Thai identity, Buddhist dates and stored totals', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const user = await login(port, 'user@example.test');
    const denied = await getFile(
      port,
      `/api/v1/reports/personal/export?year=2026&month=3&format=pdf&employeeUid=${adminUid}`,
      user,
    );
    assert.equal(denied.status, 403);

    const pdf = await getFile(port, '/api/v1/reports/personal/export?year=2026&month=3&format=pdf', user);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.disposition, 'attachment; filename="attendance-2569-03.pdf"');
    assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.buffer.includes(Buffer.from('Sarabun')));
    const mapped = pdfMappedText(pdf.buffer);
    assert.match(mapped, /ผู้ใช/);
    assert.match(mapped, /ตัวอย่าง/);
    assert.match(mapped, /E-USR/);
    assert.match(mapped, /2569/);

    const xlsx = await getFile(port, '/api/v1/reports/personal/export?year=2026&month=3&format=xlsx', user);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK');
    const xml = xlsxText(xlsx.buffer);
    assert.match(xml, /ผู้ใช้ ตัวอย่าง/);
    assert.match(xml, /E-USER/);
    assert.match(xml, /1 มีนาคม 2569 – 31 มีนาคม 2569/);
    assert.match(xml, /<v>20<\/v>/);
    assert.match(xml, /<v>22<\/v>/);
    assert.match(xml, /08:35/);
    assert.match(xml, /ลากิจ/);
    assert.doesNotMatch(xml, /2026-03-03/);

    const empty = await getFile(port, '/api/v1/reports/personal/export?year=2026&month=1&format=xlsx', user);
    const emptyXml = xlsxText(empty.buffer);
    assert.match(emptyXml, /ไม่มีข้อมูลการมาทำงานหรือการลาในช่วงนี้/);
    assert.doesNotMatch(emptyXml, /<v>0<\/v>/);
  } finally {
    server.close();
  }
});
