const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');
const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { AttendanceRepository } = require('../src/repositories/attendanceRepository');
const { LeaveRepository } = require('../src/repositories/leaveRepository');
const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { createSsoService } = require('../src/services/ssoService');
const fixtures = require('../src/dev/fixtures');

const userUid = '22222222-2222-2222-2222-222222222222';
const adminUid = '11111111-1111-1111-1111-111111111111';

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

async function login(port, email = 'user@example.test') {
  const result = await api(port, 'POST', '/api/v1/auth/login', {
    body: { email, password: 'valid-pass' },
  });
  assert.equal(result.status, 200);
  return result.body.data;
}

test('repositories read fixtures and hide password hashes', async () => {
  const employees = new EmployeeRepository(fixtures.employees);
  const found = await employees.findByEmail('user@example.test');
  assert.equal(found.employeeUid, userUid);
  const pub = await employees.findByUid(userUid);
  assert.equal(pub.passwordHash, undefined);
  const attendance = new AttendanceRepository(fixtures.attendance, fixtures.monthly);
  assert.equal((await attendance.findDaily('2026-03-02')).length, 1);
  assert.equal((await attendance.findMonthly(userUid, 2026, 3)).totalLate, 1);
  const leave = new LeaveRepository(fixtures.leave, fixtures.balances);
  assert.equal((await leave.history(userUid))[0].leaveId, 'LV-1');
  assert.equal((await leave.balance(userUid, 2026))[0].remainingDays, 5);
});

test('mariadb adapter is blocked and does not open a connection', async () => {
  const repos = createMariaDbRepositories();
  await assert.rejects(
    () => repos.employees.findByEmail('user@example.test'),
    (err) => err.code === 'DB_UNAVAILABLE' && err.status === 503,
  );
});

test('login validation, tokens, me, and logout', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const missing = await api(port, 'POST', '/api/v1/auth/login', { body: { email: 'not-an-email' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const wrong = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'wrong-pass' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');

    const locked = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'locked@example.test', password: 'valid-pass' },
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');

    const session = await login(port);
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);

    const me = await api(port, 'GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.email, 'user@example.test');
    assert.equal(me.body.data.passwordHash, undefined);

    const unauthenticated = await api(port, 'GET', '/api/v1/auth/me');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'UNAUTHORIZED');

    const refreshed = await api(port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(refreshed.status, 200);
    const reused = await api(port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, 'INVALID_REFRESH_TOKEN');

    const loggedOut = await api(port, 'POST', '/api/v1/auth/logout', {
      token: refreshed.body.data.accessToken,
      body: { refreshToken: refreshed.body.data.refreshToken },
    });
    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.body.data.revoked, true);
  } finally {
    server.close();
  }
});

test('employees, attendance, and leave enforce ownership', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const user = await login(port);
    const admin = await login(port, 'admin@example.test');

    const list = await api(port, 'GET', '/api/v1/employees', { token: user.accessToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 3);

    const detail = await api(port, 'GET', `/api/v1/employees/${userUid}`, { token: user.accessToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.employeeId, 'E-USER');

    const missing = await api(port, 'GET', '/api/v1/employees/00000000-0000-0000-0000-000000000000', {
      token: admin.accessToken,
    });
    assert.equal(missing.status, 404);

    const ownAttendance = await api(port, 'GET', `/api/v1/employees/${userUid}/attendance`, {
      token: user.accessToken,
    });
    assert.equal(ownAttendance.status, 200);
    assert.equal(ownAttendance.body.data[0].status, 'late');

    const deniedDaily = await api(port, 'GET', '/api/v1/attendance/daily/2026-03-02', {
      token: user.accessToken,
    });
    assert.equal(deniedDaily.status, 403);

    const daily = await api(port, 'GET', '/api/v1/attendance/daily/2026-03-02', {
      token: admin.accessToken,
    });
    assert.equal(daily.status, 200);
    assert.equal(daily.body.data.length, 1);

    const monthly = await api(port, 'GET', `/api/v1/attendance/monthly/${userUid}/2026/3`, {
      token: user.accessToken,
    });
    assert.equal(monthly.status, 200);
    assert.equal(monthly.body.data.totalPresent, 20);

    const otherMonthly = await api(port, 'GET', `/api/v1/attendance/monthly/${adminUid}/2026/3`, {
      token: user.accessToken,
    });
    assert.equal(otherMonthly.status, 403);
    assert.equal(otherMonthly.body.error.code, 'FORBIDDEN');

    const leaves = await api(port, 'GET', '/api/v1/leave', { token: user.accessToken });
    assert.equal(leaves.status, 200);
    assert.equal(leaves.body.data[0].leaveId, 'LV-1');

    const balance = await api(port, 'GET', `/api/v1/leave/balance/${userUid}?year=2026`, {
      token: user.accessToken,
    });
    assert.equal(balance.status, 200);
    assert.equal(balance.body.data[0].remainingDays, 5);

    const history = await api(port, 'GET', `/api/v1/leave/history/${userUid}`, {
      token: user.accessToken,
    });
    assert.equal(history.status, 200);

    const forbiddenHistory = await api(port, 'GET', `/api/v1/leave/history/${adminUid}`, {
      token: user.accessToken,
    });
    assert.equal(forbiddenHistory.status, 403);
    assert.equal(forbiddenHistory.body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('SSO stays disabled until the callback is confirmed', async () => {
  const disabled = createSsoService({ config: { sso: { enabled: false } } });
  await assert.rejects(() => disabled.login(), (err) => err.code === 'SSO_DISABLED' && err.status === 403);
  const unready = createSsoService({ config: { sso: { enabled: true } } });
  await assert.rejects(() => unready.callback(), (err) => err.code === 'SSO_NOT_READY');

  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await api(port, 'GET', '/api/v1/auth/sso/login');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'SSO_DISABLED');
  } finally {
    server.close();
  }
});
