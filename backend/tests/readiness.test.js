const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../src/app');
const { isDatabaseConfigured } = require('../src/db/pool');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  return { response, body: JSON.parse(text), text };
}

test('readiness reports ready in fixture mode without touching a database', {
  skip: isDatabaseConfigured(),
}, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const { response, body } = await getJson(port, '/api/v1/ready');
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'ready');
    assert.deepEqual(body.data.checks, { config: 'ok', database: 'not_required' });
  } finally {
    server.close();
  }
});

test('readiness and health never disclose connection details', {
  skip: isDatabaseConfigured(),
}, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    for (const path of ['/api/v1/ready', '/api/v1/health', '/api/v1/health/db']) {
      const { response, body } = await getJson(port, path);
      assert.equal(response.status, 200, path);
      const serialized = JSON.stringify(body);
      // No host, port, credential, driver or database identifier.
      assert.doesNotMatch(serialized, /"host"/, path);
      assert.doesNotMatch(serialized, /3306|3307/, path);
      assert.doesNotMatch(serialized, /password/i, path);
      assert.doesNotMatch(serialized, /127\.0\.0\.1|mariadb/i, path);
      assert.equal(body.data.database, undefined, path);
      if (body.data.checks) {
        assert.ok(['connected', 'not_required'].includes(body.data.checks.database), path);
      }
    }
  } finally {
    server.close();
  }
});

test('health/db stays unconfigured without leaking a database handle', {
  skip: isDatabaseConfigured(),
}, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const { response, body } = await getJson(port, '/api/v1/health/db');
    assert.equal(response.status, 200);
    assert.equal(body.data.status, 'unconfigured');
    assert.equal(body.data.database, undefined);
  } finally {
    server.close();
  }
});
