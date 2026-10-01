const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../src/app');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function request(port, method, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const body = await response.json();
  return { status: response.status, body };
}

test('GET /api/v1/health returns the V2 envelope', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const { status, body } = await request(port, 'GET', '/api/v1/health');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'healthy');
    assert.equal(body.data.service, 'rae-attendance-v2');
    assert.equal(body.message, 'API is running');
  } finally {
    server.close();
  }
});

test('Release 1 routes are reserved and unknown routes are 404', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const login = await request(port, 'POST', '/api/v1/auth/login');
    assert.equal(login.status, 501);
    assert.equal(login.body.success, false);
    assert.equal(login.body.error.code, 'NOT_IMPLEMENTED');

    const missing = await request(port, 'GET', '/api/attendance');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  } finally {
    server.close();
  }
});
