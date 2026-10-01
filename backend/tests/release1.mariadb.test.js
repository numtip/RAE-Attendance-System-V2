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

test('Release 1 MariaDB paths: refresh rotation, employees, monthly, leave history', {
  skip: !shouldRunMariaDbIntegration(),
}, async (t) => {
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
    assert.ok(login.body.data.refreshToken);

    const refreshed = await api(port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: login.body.data.refreshToken },
    });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.data.accessToken);
    assert.ok(refreshed.body.data.refreshToken);
    assert.notEqual(refreshed.body.data.refreshToken, login.body.data.refreshToken);

    const reused = await api(port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: login.body.data.refreshToken },
    });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, 'INVALID_REFRESH_TOKEN');

    const token = refreshed.body.data.accessToken;

    const employees = await api(port, 'GET', '/api/v1/employees', { token });
    assert.equal(employees.status, 200);
    assert.equal(employees.body.data.length, 3);
    assert.ok(employees.body.data.every((row) => row.passwordHash === undefined));

    const monthly = await api(port, 'GET', `/api/v1/attendance/monthly/${userUid}/2026/3`, { token });
    assert.equal(monthly.status, 200);
    assert.equal(monthly.body.data.totalPresent, 20);
    assert.equal(monthly.body.data.totalLate, 1);

    const history = await api(port, 'GET', `/api/v1/leave/history/${userUid}`, { token });
    assert.equal(history.status, 200);
    assert.equal(history.body.data[0].leaveId, 'LV-1');
    assert.equal(history.body.data[0].status, 'approved');
  } finally {
    delete process.env.DATA_SOURCE;
  }
});
