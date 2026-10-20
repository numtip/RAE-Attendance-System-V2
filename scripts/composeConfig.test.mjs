/**
 * Static regression tests for the Compose contract.
 *
 * These are deliberately text-based: Docker is not available in every CI job
 * that needs to know that a destructive default cannot come back. They guard
 * the two defects fixed in PR #53 review:
 *   F9 - the backend had a placeholder JWT_SECRET default (crash loop).
 *   F1  - the seed service hardcoded the guard's own acknowledgement flags.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8');
const lines = compose.split(/\r?\n/);

/** Return the body of a top-level service block (services are indented by 2). */
function serviceBlock(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `service ${name} is missing`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

test('F9: the backend has no placeholder JWT_SECRET default', () => {
  const backend = serviceBlock('backend');
  assert.doesNotMatch(backend, /dev-only-change-me/);
  assert.doesNotMatch(backend, /replace-at-runtime/);
  assert.doesNotMatch(compose, /dev-only-change-me/);
  const secretLine = backend.split('\n').find((line) => /^\s+JWT_SECRET:/.test(line));
  assert.ok(secretLine, 'backend must pass JWT_SECRET explicitly');
  // No literal default at all: any non-empty fallback reintroduces F9.
  assert.match(secretLine, /^\s+JWT_SECRET: \$\{JWT_SECRET:-\}$/);
});

test('F9: the backend restart policy is bounded', () => {
  const backend = serviceBlock('backend');
  assert.match(backend, /restart: on-failure:3/, 'an invalid configuration must stop, not flap');
});

test('F1: the seed service defaults to refusing', () => {
  const seed = serviceBlock('seed');
  assert.match(seed, /DEPLOY_ENV: \$\{DEPLOY_ENV:-staging\}/, 'DEPLOY_ENV must default to a refused value');
  assert.match(seed, /ALLOW_FIXTURE_SEED: \$\{ALLOW_FIXTURE_SEED:-false\}/, 'the acknowledgement must default to false');
  assert.doesNotMatch(seed, /ALLOW_FIXTURE_SEED: 'true'/);
  assert.doesNotMatch(seed, /DEPLOY_ENV: fixture/);
});

test('F1: the seed service is never part of the default stack', () => {
  assert.match(serviceBlock('seed'), /profiles: \['fixture-seed'\]/);
});

test('F1: the migrate service runs migrations only', () => {
  const migrate = serviceBlock('migrate');
  assert.match(migrate, /npm run db:migrate"$/m);
  assert.doesNotMatch(migrate, /db:migrate:seed/);
  assert.doesNotMatch(migrate, /db:seed/);
});

test('F1: no service other than seed can run the fixture seed', () => {
  for (const name of ['mariadb', 'migrate', 'backend', 'frontend']) {
    assert.doesNotMatch(serviceBlock(name), /db:seed|db:migrate:seed/, `${name} must not seed`);
  }
});
