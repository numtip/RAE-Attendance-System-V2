/**
 * Slice 1 API contract: GET /api/v1/employees/:employeeUid/assignments
 * Authenticated, scope-enforced, effective-dated. Fixture mode only (no database).
 */
process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('./helpers/syntheticIdentifierKeys');

const { createApp } = require('../src/app');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function api(port, method, path, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function login(port, email) {
  const response = await api(port, 'POST', '/api/v1/auth/login', { body: { email, password: 'valid-pass' } });
  assert.equal(response.status, 200);
  return response.body.data;
}

test('assignments endpoint: authentication, scope and effective dating', async () => {
  const app = createApp({ dataSource: 'fixture' });
  const { server, port } = await listen(app);
  try {
    const anonymous = await api(port, 'GET', `/api/v1/employees/${USER_UID}/assignments`);
    assert.equal(anonymous.status, 401);

    const user = await login(port, 'user@example.test');
    const admin = await login(port, 'admin@example.test');

    const own = await api(port, 'GET', `/api/v1/employees/${USER_UID}/assignments`, { token: user.accessToken });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.length, 2, 'the fixture employee has a closed and an open assignment');
    assert.deepEqual(
      own.body.data.map((row) => row.effectiveFrom),
      ['2023-10-01', '2025-10-01'],
      'ordered by effective_from ascending',
    );
    assert.equal(own.body.data[0].effectiveTo, '2025-09-30');
    assert.equal(own.body.data[1].effectiveTo, null);
    assert.equal(own.body.data[0].employeeCode, 'E-USER-A');
    assert.equal(own.body.data[1].employeeCode, 'E-USER');
    assert.equal(JSON.stringify(own.body.data).includes('passwordHash'), false);

    const asOfPast = await api(
      port,
      'GET',
      `/api/v1/employees/${USER_UID}/assignments?onDate=2024-01-01`,
      { token: user.accessToken },
    );
    assert.equal(asOfPast.status, 200);
    assert.equal(asOfPast.body.data.length, 1);
    assert.equal(asOfPast.body.data[0].employeeCode, 'E-USER-A');

    const asOfNow = await api(
      port,
      'GET',
      `/api/v1/employees/${USER_UID}/assignments?onDate=2026-01-01`,
      { token: user.accessToken },
    );
    assert.equal(asOfNow.status, 200);
    assert.equal(asOfNow.body.data.length, 1);
    assert.equal(asOfNow.body.data[0].employeeCode, 'E-USER');

    const badDate = await api(
      port,
      'GET',
      `/api/v1/employees/${USER_UID}/assignments?onDate=not-a-date`,
      { token: user.accessToken },
    );
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.error.code, 'ASSIGNMENT_INVALID_DATE');

    const otherEmployee = await api(port, 'GET', `/api/v1/employees/${ADMIN_UID}/assignments`, {
      token: user.accessToken,
    });
    assert.equal(otherEmployee.status, 403);
    assert.equal(otherEmployee.body.error.code, 'FORBIDDEN');

    const adminReads = await api(port, 'GET', `/api/v1/employees/${ADMIN_UID}/assignments`, {
      token: admin.accessToken,
    });
    assert.equal(adminReads.status, 200);
    assert.equal(adminReads.body.data.length, 1);
    assert.equal(adminReads.body.data[0].employeeCode, 'E-ADMIN');
  } finally {
    server.close();
  }
});
