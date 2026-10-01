const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');
const { closePool } = require('../src/db/pool');

const userUid = '22222222-2222-2222-2222-222222222222';

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return isDatabaseConfigured();
  }
  return false;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
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

test('MariaDB repositories match dev fixture data', { skip: !shouldRunMariaDbIntegration() }, async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
  process.env.DATA_SOURCE = 'mariadb';

  const { createApp } = require('../src/app');
  const app = createApp();
  const { server, port } = await listen(app);

  t.after(async () => {
    server.close();
    await closePool();
  });

  try {
    const login = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.data.accessToken);

    const me = await api(port, 'GET', '/api/v1/auth/me', { token: login.body.data.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.employeeId, 'E-USER');

    const attendance = await api(port, 'GET', `/api/v1/employees/${userUid}/attendance`, {
      token: login.body.data.accessToken,
    });
    assert.equal(attendance.status, 200);
    assert.equal(attendance.body.data[0].status, 'late');
    assert.equal(attendance.body.data[0].date, '2026-03-02');

    const leaves = await api(port, 'GET', '/api/v1/leave', { token: login.body.data.accessToken });
    assert.equal(leaves.status, 200);
    assert.equal(leaves.body.data[0].leaveId, 'LV-1');

    const balance = await api(port, 'GET', `/api/v1/leave/balance/${userUid}?year=2026`, {
      token: login.body.data.accessToken,
    });
    assert.equal(balance.status, 200);
    assert.equal(balance.body.data[0].remainingDays, 5);
  } finally {
    delete process.env.DATA_SOURCE;
  }
});
