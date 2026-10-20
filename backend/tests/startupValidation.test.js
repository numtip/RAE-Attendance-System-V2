const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const serverEntry = require.resolve('../src/server.js');

function startServer(envOverrides) {
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ...envOverrides,
  };
  return spawnSync(process.execPath, [serverEntry], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('startup fails closed in production when JWT_SECRET is missing', () => {
  const result = startServer({
    NODE_ENV: 'production',
    DATA_SOURCE: 'mariadb',
    DB_HOST: '127.0.0.1',
    DB_NAME: 'attendance_v2',
    DB_USER: 'app',
    DB_PASSWORD: 'pw',
    JWT_SECRET: '',
    PORT: '0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONFIG_INVALID/);
  assert.match(result.stderr, /JWT_SECRET_MISSING/);
});

test('startup fails closed in production when JWT_SECRET is a placeholder', () => {
  const result = startServer({
    NODE_ENV: 'production',
    DATA_SOURCE: 'mariadb',
    DB_HOST: '127.0.0.1',
    DB_NAME: 'attendance_v2',
    DB_USER: 'app',
    DB_PASSWORD: 'pw',
    JWT_SECRET: 'dev-only-change-me',
    PORT: '0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET_PLACEHOLDER/);
  // The value must not be echoed into logs.
  assert.doesNotMatch(result.stderr, /dev-only-change-me/);
});

test('startup fails closed in production when required DB settings are missing', () => {
  const result = startServer({
    NODE_ENV: 'production',
    DATA_SOURCE: 'mariadb',
    JWT_SECRET: 'a'.repeat(32),
    PORT: '0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DB_HOST_MISSING/);
  assert.match(result.stderr, /DB_PASSWORD_MISSING/);
});
