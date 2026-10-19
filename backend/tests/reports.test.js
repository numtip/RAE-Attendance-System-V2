const assert = require('node:assert/strict');
const http = require('node:http');
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

async function api(port, method, path, { token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

test('personal report uses the caller row and ignores another employee id', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const anon = await api(port, 'GET', '/api/v1/reports/personal?year=2026&month=3');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'UNAUTHORIZED');

    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'valid-pass' }),
    });
    const session = await login.json();
    assert.equal(login.status, 200);
    const token = session.data.accessToken;

    const report = await api(
      port,
      'GET',
      `/api/v1/reports/personal?year=2026&month=3&employeeUid=${adminUid}`,
      { token },
    );
    assert.equal(report.status, 200);
    assert.equal(report.body.data.employeeUid, userUid);
    assert.equal(report.body.data.present, 20);
    assert.equal(report.body.data.late, 1);
    assert.equal(report.body.data.absent, 0);
    assert.equal(report.body.data.leaveDaysOnSummary, 1);
    assert.equal(report.body.data.leaveRowsInMonth, 1);
    assert.equal(report.body.data.remainingLeaveDays, 5);
    assert.equal(report.body.data.source, 'stored-monthly-and-leave');

    const missing = await api(port, 'GET', '/api/v1/reports/personal?year=2026&month=1', { token });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
