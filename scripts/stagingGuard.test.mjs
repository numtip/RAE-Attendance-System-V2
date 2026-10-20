import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'migrate.mjs');

// Minimal, explicit environment: the parent process must not be able to make a
// destructive seed legal by accident.
function baseEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3307',
    MYSQL_USER: 'attendance',
    MYSQL_PASSWORD: 'attendance',
    MYSQL_DATABASE: 'attendance_v2',
    ...overrides,
  };
}

function run(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('seed is refused without ALLOW_FIXTURE_SEED', () => {
  const result = run(['--seed'], baseEnv());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ALLOW_FIXTURE_SEED/);
  assert.match(result.stderr, /no connection was opened/);
});

test('seed is refused when DEPLOY_ENV is staging', () => {
  const result = run(['--seed'], baseEnv({ DEPLOY_ENV: 'staging', ALLOW_FIXTURE_SEED: 'true' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEPLOY_ENV must be one of/);
  assert.match(result.stderr, /"staging"/);
  assert.match(result.stderr, /no connection was opened/);
});

test('seed is refused when DEPLOY_ENV is production', () => {
  const result = run(['--seed-only'], baseEnv({ DEPLOY_ENV: 'production', ALLOW_FIXTURE_SEED: 'true' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEPLOY_ENV must be one of/);
  assert.match(result.stderr, /"production"/);
});

test('seed is refused when NODE_ENV is production', () => {
  const result = run([
    '--seed',
  ], baseEnv({ NODE_ENV: 'production', DEPLOY_ENV: 'fixture', ALLOW_FIXTURE_SEED: 'true' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NODE_ENV must be one of/);
});

test('seed is refused for every unrecognised DEPLOY_ENV (allowlist, not denylist)', () => {
  for (const deployEnv of ['stage', 'prod', 'uat', 'preprod', 'Staging ', 'live', '']) {
    const result = run(['--seed'], baseEnv({
      DEPLOY_ENV: deployEnv,
      ALLOW_FIXTURE_SEED: 'true',
    }));
    assert.equal(result.status, 1, `DEPLOY_ENV="${deployEnv}" must be refused`);
    assert.match(result.stderr, /DEPLOY_ENV must be one of/, `DEPLOY_ENV="${deployEnv}"`);
    assert.match(result.stderr, /no connection was opened/);
  }
});

test('seed is refused when DEPLOY_ENV is entirely unset', () => {
  const env = baseEnv({ ALLOW_FIXTURE_SEED: 'true' });
  delete env.DEPLOY_ENV;
  const result = run(['--seed'], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /an unset value/);
});

test('seed is permitted for each allowlisted environment', () => {
  for (const deployEnv of ['fixture', 'development', 'test']) {
    const result = run(['--seed'], baseEnv({
      DEPLOY_ENV: deployEnv,
      ALLOW_FIXTURE_SEED: 'true',
    }));
    // The guard passes; the run only fails later because it cannot connect.
    assert.doesNotMatch(result.stderr, /seed refused/, `DEPLOY_ENV=${deployEnv} should be allowed`);
  }
});

test('seed is refused for a non-disposable database host', () => {
  const result = run([
    '--seed',
  ], baseEnv({
    MYSQL_HOST: 'db.production.example',
    DEPLOY_ENV: 'fixture',
    ALLOW_FIXTURE_SEED: 'true',
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /db\.production\.example/);
  assert.match(result.stderr, /ALLOW_REMOTE_FIXTURE_SEED/);
});

test('the compose service host is treated as disposable', () => {
  const result = run(['--seed'], baseEnv({
    MYSQL_HOST: 'mariadb',
    DEPLOY_ENV: 'fixture',
    ALLOW_FIXTURE_SEED: 'true',
  })); // The guard passes, so the run only fails later when it cannot connect.
  assert.doesNotMatch(result.stderr, /seed refused/);
});

test('--dry-run with the seed never trips the guard because nothing runs', () => {
  const result = run(['--seed', '--dry-run'], baseEnv());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Would run seed:/);
});
