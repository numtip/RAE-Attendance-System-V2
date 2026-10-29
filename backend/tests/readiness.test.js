const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { closePool, isDatabaseConfigured } = require('../src/db/pool');

// With a database configured, /api/v1/ready opens the shared mysql pool and nothing closed it, so
// `node --test` waited on the open handle forever (killed at 420 s; CI hid it by using
// --test-force-exit). Closing here costs nothing when no database is configured.
test.after(async () => {
  await closePool();
});

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

async function withApp(run, options) {
  const app = createApp(options);
  const { server, port } = await listen(app);
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

test('readiness reports ready in fixture mode without touching a database', {
  skip: isDatabaseConfigured(),
}, async () => {
  await withApp(async (port) => {
    const { response, body } = await getJson(port, '/api/v1/ready');
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'ready');
    assert.deepEqual(body.data.checks, { config: 'ok', database: 'not_required' });
  });
});

// F11: this ran only in the fixture job before, so it never asserted anything
// against a live database. It now runs in both jobs.
test('readiness and health never disclose connection details', async () => {
  await withApp(async (port) => {
    for (const path of ['/api/v1/ready', '/api/v1/health', '/api/v1/health/db']) {
      const { body } = await getJson(port, path);
      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /"host"/, path);
      assert.doesNotMatch(serialized, /"password"/i, path);
      assert.doesNotMatch(serialized, /3306|3307/, path);
      assert.doesNotMatch(serialized, /127\.0\.0\.1|localhost|mariadb/i, path);
      assert.doesNotMatch(serialized, /ECONNREFUSED|Access denied|ER_/i, path);
      assert.equal(body.data?.database, undefined, path);
      if (body.data?.checks) {
        assert.ok(['connected', 'not_required'].includes(body.data.checks.database), path);
      }
      if (path.endsWith('/health/db')) {
        // With a database configured but unreachable the endpoint answers 503 with an error
        // envelope and no `data` — that is a legitimate state, not a disclosure. Only a body that
        // carries a status is checked here.
        if (body.data?.status !== undefined) {
          assert.ok(['connected', 'unconfigured'].includes(body.data.status), path);
        }
      }
    }
  });
});

test('health/db stays unconfigured without leaking a database handle', {
  skip: isDatabaseConfigured(),
}, async () => {
  await withApp(async (port) => {
    const { response, body } = await getJson(port, '/api/v1/health/db');
    assert.equal(response.status, 200);
    assert.equal(body.data.status, 'unconfigured');
    assert.equal(body.data.database, undefined);
  });
});

test('readiness answers 503 CONFIG_INVALID with codes only when production config is invalid', async () => {
  const previous = { env: config.app.env, secret: config.jwt.secret };
  try {
    config.app.env = 'production';
    config.jwt.secret = '';
    // dataSource mariadb satisfies createContainer's production guard; the
    // readiness route rejects the configuration before any query is attempted.
    await withApp(async (port) => {
      const { response, body } = await getJson(port, '/api/v1/ready');
      assert.equal(response.status, 503);
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'CONFIG_INVALID');
      assert.match(body.error.message, /JWT_SECRET_MISSING/);
      // Codes only: no secret value, no connection detail.
      assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|3306|password/i);
    }, { dataSource: 'mariadb' });
  } finally {
    config.app.env = previous.env;
    config.jwt.secret = previous.secret;
  }
});
