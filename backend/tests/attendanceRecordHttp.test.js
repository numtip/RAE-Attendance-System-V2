const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');

const userUid = '22222222-2222-2222-2222-222222222222';

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

async function staffToken(port) {
  const result = await api(port, 'POST', '/api/v1/auth/login', {
    body: { email: 'user@example.test', password: 'valid-pass' },
  });
  assert.equal(result.status, 200, 'the fixture staff account must sign in');
  return result.body.data.accessToken;
}

test('the attendance write route is mounted and refuses an anonymous caller', async (t) => {
  const { server, port } = await listen(createApp());
  t.after(() => server.close());

  const anonymous = await api(port, 'POST', `/api/v1/attendance/daily/${userUid}/2026-11-16`, {
    body: { checkIn: '08:30', checkOut: '16:30' },
  });
  assert.equal(anonymous.status, 401);
});

test('validation runs before authorization, so a malformed request is a 400 not a 403', async (t) => {
  const { server, port } = await listen(createApp());
  t.after(() => server.close());
  const token = await staffToken(port);

  const badDate = await api(port, 'POST', `/api/v1/attendance/daily/${userUid}/16-11-2026`, {
    token,
    body: { checkIn: '08:30' },
  });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');

  const badTime = await api(port, 'POST', `/api/v1/attendance/daily/${userUid}/2026-11-16`, {
    token,
    body: { checkIn: '8:30' },
  });
  assert.equal(badTime.status, 400);

  const noFact = await api(port, 'POST', `/api/v1/attendance/daily/${userUid}/2026-11-16`, {
    token,
    body: {},
  });
  assert.equal(noFact.status, 400);
  assert.match(noFact.body.error.message, /at least one fact|record at least one fact/);
});

test('a staff member with a valid request is refused: attendance is not self-service', async (t) => {
  const { server, port } = await listen(createApp());
  t.after(() => server.close());
  const token = await staffToken(port);

  const own = await api(port, 'POST', `/api/v1/attendance/daily/${userUid}/2026-11-16`, {
    token,
    body: { checkIn: '08:30', checkOut: '16:30' },
  });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'FORBIDDEN');
});
