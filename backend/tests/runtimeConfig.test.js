const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIN_JWT_SECRET_LENGTH,
  validateRuntimeConfig,
} = require('../src/config/validate');

function productionConfig(overrides = {}) {
  return {
    app: { env: 'production' },
    jwt: { secret: 'a'.repeat(32) },
    database: { host: 'db', port: 3306, name: 'attendance_v2', user: 'app', password: 'pw' },
    ...overrides,
  };
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test('production configuration passes when everything is set', () => {
  const result = validateRuntimeConfig(productionConfig(), {
    env: { DATA_SOURCE: 'mariadb' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('non-production configuration is not blocked', () => {
  const result = validateRuntimeConfig(
    { app: { env: 'development' }, jwt: { secret: '' }, database: {} },
    { env: { DATA_SOURCE: 'fixture' } },
  );
  assert.equal(result.ok, true);
});

test('a missing JWT_SECRET is reported in production', () => {
  const result = validateRuntimeConfig(productionConfig({ jwt: { secret: '' } }), {
    env: { DATA_SOURCE: 'mariadb' },
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('JWT_SECRET_MISSING'));
});

test('a repository placeholder JWT_SECRET is rejected', () => {
  for (const placeholder of ['dev-only-change-me', 'replace-at-runtime']) {
    const result = validateRuntimeConfig(productionConfig({ jwt: { secret: placeholder } }), {
      env: { DATA_SOURCE: 'mariadb' },
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('JWT_SECRET_PLACEHOLDER'));
    // The value itself must never be echoed back.
    for (const error of result.errors) {
      assert.ok(!error.message.includes(placeholder));
    }
  }
});

test('a short JWT_SECRET is rejected', () => {
  const result = validateRuntimeConfig(productionConfig({ jwt: { secret: 'a'.repeat(MIN_JWT_SECRET_LENGTH - 1) } }), {
    env: { DATA_SOURCE: 'mariadb' },
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('JWT_SECRET_TOO_SHORT'));
});

test('DATA_SOURCE=fixture is rejected in production', () => {
  const result = validateRuntimeConfig(productionConfig(), { env: { DATA_SOURCE: 'fixture' } });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('DATA_SOURCE_INVALID'));
});

test('every required database setting is reported when absent', () => {
  const result = validateRuntimeConfig(
    productionConfig({ database: {} }),
    { env: { DATA_SOURCE: 'mariadb' } },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result).sort(), [
    'DB_HOST_MISSING',
    'DB_NAME_MISSING',
    'DB_PASSWORD_MISSING',
    'DB_USER_MISSING',
  ]);
});
