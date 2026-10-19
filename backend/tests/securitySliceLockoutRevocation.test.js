const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';

const { createApp } = require('../src/app');
const { createContainer } = require('../src/container');
const config = require('../src/config');
const { EmployeeRepository } = require('../src/repositories/employeeRepository');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createFileAccessTokenRevocationRepository } = require('../src/repositories/accessTokenRevocationRepository');
const { createEmployeeMariaDbRepository } = require('../src/repositories/mariadb/employeeMariaDbRepository');
const { createAccessTokenRevocationMariaDbRepository } = require('../src/repositories/mariadb/accessTokenRevocationMariaDbRepository');

const user = {
  employeeUid: '22222222-2222-2222-2222-222222222222',
  email: 'user@example.test',
  role: 'user',
  passwordHash: require('../src/dev/fixtures').employees.find((row) => row.email === 'user@example.test').passwordHash,
  lockedUntil: null,
  loginAttempts: 0,
};

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function api(port, method, route, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function appFor(repositories, extras = {}) {
  return createApp({
    container: { config, dataSource: 'fixture', repositories, ...extras },
  });
}

function exampleValue(name) {
  const file = fs.readFileSync(path.join(path.dirname(require.resolve('../src/app.js')), '..', '..', '.env.example'), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  assert.ok(line, name);
  return line.slice(name.length + 1);
}

test('failed logins persist under concurrency, then lock, then unlock and reset', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const employees = new EmployeeRepository([{ ...user }]);
  const policy = { maxAttempts: 2, lockMs: 1000, now: () => now };
  await Promise.all([
    employees.recordFailedLogin(user.employeeUid, policy),
    employees.recordFailedLogin(user.employeeUid, policy),
  ]);
  const row = employees.rows[0];
  assert.equal(row.loginAttempts, 2);
  assert.equal(await employees.clearLoginAttempts(user.employeeUid, now), false);

  now += 1000;
  assert.equal(await employees.clearLoginAttempts(user.employeeUid, now), true);
  assert.equal(row.loginAttempts, 0);
  assert.equal(row.lockedUntil, null);
});

test('unknown email does not create an attempt, and a locked correct password stays locked', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const repositories = createFixtureRepositories();
  const { server, port } = await listen(appFor(repositories, {
    now: () => now,
    lockout: { maxAttempts: 2, lockMs: 5000 },
  }));
  try {
    const unknown = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'missing@example.test', password: 'wrong-pass' },
    });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(repositories.employees.rows.length, 3);

    await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'wrong-pass' },
    });
    await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'wrong-pass' },
    });
    const locked = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');

    now += 5000;
    const opened = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(opened.status, 200);
    const row = repositories.employees.rows.find((item) => item.email === 'user@example.test');
    assert.equal(row.loginAttempts, 0);
    assert.equal(row.lockedUntil, null);
  } finally {
    await close(server);
  }
});

test('logout revokes the access token, replay stays revoked, and a second instance sees it after restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rae-revoke-'));
  const filePath = path.join(directory, 'revoked.json');
  const first = createFixtureRepositories();
  const second = createFixtureRepositories();
  first.accessTokenRevocations = createFileAccessTokenRevocationRepository(filePath);
  second.accessTokenRevocations = createFileAccessTokenRevocationRepository(filePath);
  const firstServer = await listen(appFor(first));
  const secondServer = await listen(appFor(second));
  try {
    const session = await api(firstServer.port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(session.status, 200);
    const token = session.body.data.accessToken;
    const seen = await api(firstServer.port, 'GET', '/api/v1/auth/me', { token });
    assert.equal(seen.status, 200);

    const loggedOut = await api(firstServer.port, 'POST', '/api/v1/auth/logout', {
      token,
      body: { refreshToken: session.body.data.refreshToken },
    });
    assert.equal(loggedOut.status, 200);

    const replay = await api(firstServer.port, 'GET', '/api/v1/auth/me', { token });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'ACCESS_TOKEN_REVOKED');
    const again = await api(firstServer.port, 'GET', '/api/v1/auth/me', { token });
    assert.equal(again.status, 401);
    assert.equal(again.body.error.code, 'ACCESS_TOKEN_REVOKED');

    const otherInstance = await api(secondServer.port, 'GET', '/api/v1/auth/me', { token });
    assert.equal(otherInstance.status, 401);
    assert.equal(otherInstance.body.error.code, 'ACCESS_TOKEN_REVOKED');
  } finally {
    await close(firstServer.server);
    await close(secondServer.server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing or unreadable revocation store fails closed', async () => {
  const missing = createFixtureRepositories();
  delete missing.accessTokenRevocations;
  const missingServer = await listen(appFor(missing));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rae-revoke-bad-'));
  const filePath = path.join(directory, 'revoked.json');
  fs.writeFileSync(filePath, '{', 'utf8');
  const broken = createFixtureRepositories();
  broken.accessTokenRevocations = createFileAccessTokenRevocationRepository(filePath);
  const brokenServer = await listen(appFor(broken));
  try {
    const session = await api(missingServer.port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(session.status, 200);
    const denied = await api(missingServer.port, 'GET', '/api/v1/auth/me', {
      token: session.body.data.accessToken,
    });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error.code, 'REVOCATION_STORE_UNAVAILABLE');

    const other = await api(brokenServer.port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assert.equal(other.status, 200);
    const unreadable = await api(brokenServer.port, 'GET', '/api/v1/auth/me', {
      token: other.body.data.accessToken,
    });
    assert.equal(unreadable.status, 503);
    assert.equal(unreadable.body.error.code, 'REVOCATION_STORE_UNAVAILABLE');
  } finally {
    await close(missingServer.server);
    await close(brokenServer.server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lockout state errors fail closed and do not issue a session', async () => {
  const repositories = createFixtureRepositories();
  repositories.employees.recordFailedLogin = async () => {
    throw new Error('lockout store down');
  };
  const { server, port } = await listen(appFor(repositories));
  try {
    const failed = await api(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'wrong-pass' },
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'LOCKOUT_STATE_UNAVAILABLE');
  } finally {
    await close(server);
  }
});

test('example file leaves SSO gates off and uses an inert client id', () => {
  assert.equal(exampleValue('SSO_ENABLED'), 'false');
  assert.equal(exampleValue('SSO_CALLBACK_CONFIRMED'), 'false');
  assert.equal(exampleValue('SSO_SUBJECT_CONTRACT_CONFIRMED'), 'false');
  assert.equal(exampleValue('SSO_CLIENT_ID'), 'example-client-id');
  assert.equal(/^[a-f0-9]{32}$/i.test(exampleValue('SSO_CLIENT_ID')), false);
});

test('mariadb repositories lock a row and insert a revocation without a live database', async () => {
  const employee = {
    login_attempts: 1,
    locked_until: null,
  };
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params) {
          if (sql.includes('FOR UPDATE')) return [[employee]];
          if (sql.startsWith('UPDATE employees')) {
            employee.login_attempts = params[0];
            employee.locked_until = params[1];
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
    },
  };
  const employees = createEmployeeMariaDbRepository(pool);
  const result = await employees.recordFailedLogin(user.employeeUid, { maxAttempts: 2, lockMs: 1000 });
  assert.equal(result.loginAttempts, 2);
  assert.equal(result.locked, true);

  const revoked = new Map();
  const revocations = createAccessTokenRevocationMariaDbRepository({
    async query(sql, params) {
      if (sql.startsWith('INSERT INTO revoked_access_tokens')) {
        revoked.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM revoked_access_tokens')) {
        return [revoked.has(params[0]) ? [{ jti: params[0] }] : []];
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  });
  await revocations.revoke({ jti: '11111111-1111-1111-1111-111111111111', expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(await revocations.isRevoked('11111111-1111-1111-1111-111111111111'), true);
  await assert.rejects(
    () => createAccessTokenRevocationMariaDbRepository({
      async query() { throw new Error('database down'); },
    }).isRevoked('any'),
    /database down/,
  );
});

test('production does not fall back to the in-memory revocation store', () => {
  assert.throws(
    () => createContainer({
      dataSource: 'fixture',
      config: { app: { env: 'production' }, database: {} },
    }),
    (error) => error.code === 'REVOCATION_STORE_UNAVAILABLE' && error.status === 503,
  );
});

test('Docker/MariaDB lockout and revocation runtime', { skip: 'Covered by securitySlice.mariadb.integration.test.js when RUN_SECURITY_MARIADB=1' }, () => {});
