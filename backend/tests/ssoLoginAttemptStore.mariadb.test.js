const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/pool');
const { createSsoStateStore } = require('../src/services/sso/ssoStateStore');
const {
  createMariaDbLoginAttemptBackend,
  digestHex,
} = require('../src/services/sso/mariadbLoginAttemptBackend');

/**
 * G-02 — the shared login attempt store against a real MariaDB.
 *
 * These tests are the reason the store is not trusted on unit tests alone. Everything that
 * matters here is a property of the *database*, not of JavaScript:
 *
 *   - two consumers racing for one attempt: exactly one wins (SELECT ... FOR UPDATE + DELETE)
 *   - a second process sees an attempt created by the first (shared, not process-local)
 *   - the table holds digests only, never the state or the binding
 *   - a lost connection fails closed (503) instead of falling back to memory
 *
 * Gated like the rest of the MariaDB suite: RUN_MARIADB_TESTS=1, or CI with a configured DB.
 * Requires migration 028_sso_login_attempt.sql to have been applied.
 */

function shouldRun() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const gated = !shouldRun();

test(
  'migration 028 applied: the attempt table exists',
  { skip: gated ? 'MariaDB integration is not enabled (set RUN_MARIADB_TESTS=1)' : false },
  async () => {
    const pool = getPool();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', ['sso_login_attempt']);
    assert.equal(rows.length, 1, 'sso_login_attempt is missing; apply migration 028');
    await closePool();
  },
);

test(
  'an attempt created in one process is consumed by another (shared, not process-local)',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();

    // Two independent store instances over the same database stand in for two app instances.
    const instanceA = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });
    const instanceB = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });

    assert.equal(instanceA.shared, true, 'the MariaDB backend must report itself shared');
    assert.equal(instanceA.durable, true);

    const binding = 'shared-binding-value-32-chars-long';
    const state = await instanceA.create({ binding });

    // Created on A, completed on B: a rolling deploy must not lose in-flight logins.
    assert.equal(await instanceB.consume(state, binding), true);
    assert.equal(await instanceB.consume(state, binding), false, 'still single use across instances');

    await closePool();
  },
);

test(
  'concurrent consumers of one attempt: exactly one wins',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();
    const binding = 'race-binding-value-32-characters-x';
    const store = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });
    const state = await store.create({ binding });

    // Distinct store objects so the race is in the database, not in one object's bookkeeping.
    const contenders = Array.from({ length: 8 }, () =>
      createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) }).consume(state, binding),
    );
    const results = await Promise.all(contenders);

    assert.equal(
      results.filter(Boolean).length,
      1,
      `exactly one consumer may win, got ${results.filter(Boolean).length}`,
    );

    await closePool();
  },
);

test(
  'the table stores digests only — never the state or the binding',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();
    const store = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });
    const binding = 'plaintext-binding-value-32-char-long';
    const state = await store.create({ binding });

    const [rows] = await pool.query(
      'SELECT state_digest, binding_digest FROM sso_login_attempt WHERE state_digest = ?',
      [digestHex(state)],
    );
    assert.equal(rows.length, 1);

    const row = rows[0];
    assert.match(row.state_digest, /^[0-9a-f]{64}$/);
    assert.match(row.binding_digest, /^[0-9a-f]{64}$/);
    assert.equal(row.state_digest, digestHex(state));

    // Reading the whole row must not reveal either secret.
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(state), false, 'the state value must not be recoverable');
    assert.equal(serialized.includes(binding), false, 'the binding must not be recoverable');

    await store.consume(state, binding);
    await closePool();
  },
);

test(
  'expired attempts are refused and pruned',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();
    // A 1-second TTL keeps the test fast without weakening the production default.
    const backend = createMariaDbLoginAttemptBackend(pool, { ttlSeconds: 1 });
    const store = createSsoStateStore({ ttlMs: 1000, backend });
    const binding = 'expiring-binding-value-32-chars0';
    const state = await store.create({ binding });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(await store.consume(state, binding), false, 'an expired attempt must be refused');
    await backend.prune();
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM sso_login_attempt WHERE state_digest = ?', [
      digestHex(state),
    ]);
    assert.equal(Number(rows[0].n), 0, 'prune must remove the expired row');

    await closePool();
  },
);

test(
  'a failing database fails closed with 503 and never falls back to memory',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();
    const store = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });
    const binding = 'closed-connection-binding-32chrs';
    const state = await store.create({ binding });

    await closePool(); // every later query fails

    await assert.rejects(
      () => createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) }).consume(state, binding),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'SSO_LOGIN_STORE_UNAVAILABLE');
        return true;
      },
    );
  },
);

test(
  'the backend reports its own capabilities honestly',
  { skip: gated ? 'MariaDB integration is not enabled' : false },
  async () => {
    const pool = getPool();
    const store = createSsoStateStore({ backend: createMariaDbLoginAttemptBackend(pool) });
    assert.equal(store.kind, 'mariadb');
    assert.equal(store.shared, true);
    assert.equal(store.durable, true);
    const stats = await store.stats();
    assert.equal(typeof stats.pending, 'number');
    await closePool();
  },
);
