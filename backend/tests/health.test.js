const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../src/app');
const { closePool, isDatabaseConfigured } = require('../src/db/pool');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('GET /api/v1/health/db reports unconfigured when DB env is empty', { skip: isDatabaseConfigured() }, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health/db`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'unconfigured');
  } finally {
    server.close();
  }
});

test('GET /api/v1/health/db reports connected when MariaDB is configured', {
  skip: !isDatabaseConfigured() || process.env.RUN_MARIADB_TESTS !== '1',
}, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health/db`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.status, 'connected');
  } finally {
    server.close();
    await closePool();
  }
});

test('GET /api/v1/health returns the V2 envelope', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'healthy');
    assert.equal(body.data.service, 'rae-attendance-v2');
  } finally {
    server.close();
  }
});

test('unknown routes use the error envelope', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/attendance`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally {
    server.close();
  }
});
