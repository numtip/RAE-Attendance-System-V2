const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');
const { createAttendanceComputeService } = require('../src/services/attendanceComputeService');

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

async function login(port, email = 'admin@example.test') {
  const result = await api(port, 'POST', '/api/v1/auth/login', {
    body: { email, password: 'valid-pass' },
  });
  assert.equal(result.status, 200);
  return result.body.data;
}

test('attendance compute service delegates to core client', async () => {
  const service = createAttendanceComputeService({
    coreClient: {
      async evaluateDay(payload) {
        assert.equal(payload.employee_id, 'E-100');
        assert.equal(payload.date, '2026-08-03');
        return {
          employee_id: payload.employee_id,
          date: payload.date,
          attendance_status: 'PRESENT',
          late_minutes: 0,
          early_minutes: 0,
          missing_check_in: false,
          missing_check_out: false,
          leave_type: null,
          issues: [],
        };
      },
    },
  });
  const result = await service.evaluateDay(
    { role: 'admin', employeeUid: '11111111-1111-1111-1111-111111111111' },
    {
      employee_id: 'E-100',
      date: '2026-08-03',
      check_in: '08:11:00',
      check_out: '16:36:00',
      source: 'API',
    },
  );
  assert.equal(result.attendance_status, 'PRESENT');
  assert.equal(result.explainedBy, 'attendance-core');
});

test('evaluate-day route requires manager/admin and configured core', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const user = await login(port, 'user@example.test');
    const forbidden = await api(port, 'POST', '/api/v1/attendance/evaluate-day', {
      token: user.accessToken,
      body: { employee_id: 'E-100', date: '2026-08-03' },
    });
    assert.equal(forbidden.status, 403);

    const admin = await login(port, 'admin@example.test');
    const unavailable = await api(port, 'POST', '/api/v1/attendance/evaluate-day', {
      token: admin.accessToken,
      body: { employee_id: 'E-100', date: '2026-08-03' },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'ATTENDANCE_CORE_UNAVAILABLE');
  } finally {
    server.close();
  }
});
