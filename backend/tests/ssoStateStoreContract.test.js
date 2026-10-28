const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSsoStateStore,
  createInMemoryStateBackend,
  DEFAULT_TTL_MS,
} = require('../src/services/sso/ssoStateStore');

/**
 * G-02 — the SSO login state store.
 *
 * The store used to be a bare in-memory Map with no browser binding. These tests cover the two
 * properties that were missing, and define the contract a *durable* backend must satisfy so a
 * Redis/SQL implementation can be added without re-deriving them.
 */

test('a state is single use', async () => {
  const store = createSsoStateStore();
  const state = await store.create();
  assert.equal(await store.consume(state), true);
  assert.equal(await store.consume(state), false, 'a consumed state must never be accepted again');
});

test('an unknown or malformed state is refused', async () => {
  const store = createSsoStateStore();
  assert.equal(await store.consume('never-issued'), false);
  assert.equal(await store.consume(''), false);
  assert.equal(await store.consume(undefined), false);
  assert.equal(await store.consume(null), false);
});

test('an expired state is refused even on first presentation', async () => {
  let now = 1_000_000;
  const store = createSsoStateStore({ ttlMs: 1000, now: () => now });
  const state = await store.create();
  now += 1001;
  assert.equal(await store.consume(state), false);
});

test('a binding is enforced when one was registered', async () => {
  const store = createSsoStateStore();
  const binding = 'b'.repeat(32);
  const state = await store.create({ binding });

  assert.equal(await store.consume(state, 'a'.repeat(32)), false, 'a different binding must fail');
  assert.equal(await store.consume(state), false, 'omitting the binding must fail');
  assert.equal(await store.consume(state, binding), false, 'the binding is burned by the failed attempts');

  const second = await store.create({ binding });
  assert.equal(await store.consume(second, binding), true);
});

test('a state created without a binding is not satisfied by presenting one', async () => {
  const store = createSsoStateStore();
  const state = await store.create();
  assert.equal(await store.consume(state, 'c'.repeat(32)), false);
});

test('a weak binding is refused at creation', async () => {
  const store = createSsoStateStore();
  await assert.rejects(() => store.create({ binding: 'short' }), /at least 16 characters/);
  await assert.rejects(() => store.create({ binding: 12345 }), /at least 16 characters/);
});

test('the binding value is not recoverable from the store', async () => {
  const backend = createInMemoryStateBackend();
  const store = createSsoStateStore({ backend });
  const binding = 'super-secret-binding-value-0123456789';
  const state = await store.create({ binding });

  const entry = await backend.get(state);
  assert.ok(entry);
  assert.equal(JSON.stringify(entry).includes(binding), false, 'a digest, never the value');
  assert.match(entry.bindingDigest, /^[0-9a-f]{64}$/);
});

test('the in-memory backend is honest about not being durable or shared', () => {
  const store = createSsoStateStore();
  assert.equal(store.durable, false);
  assert.equal(store.shared, false);
  assert.equal(store.kind, 'in-memory');
});

test('default ttl is bounded and exported', () => {
  assert.equal(DEFAULT_TTL_MS, 10 * 60 * 1000);
});

test('the map is bounded so an attacker cannot grow it without limit', async () => {
  const backend = createInMemoryStateBackend({ maxEntries: 3 });
  const store = createSsoStateStore({ backend });
  for (let index = 0; index < 8; index += 1) await store.create();
  const stats = await store.stats();
  assert.ok(stats.pending <= 3, `expected <= 3 pending, got ${stats.pending}`);
});

/**
 * A durable backend must satisfy exactly these properties. A Redis/SQL implementation that
 * passes them can be injected without changing the service layer.
 */
test('a shared backend can be injected and keeps the same semantics', async () => {
  const shared = new Map();
  let now = 5_000_000;
  const backend = {
    kind: 'test-shared',
    durable: true,
    shared: true,
    async get(key) {
      return shared.get(key);
    },
    async set(key, entry) {
      shared.set(key, entry);
    },
    async delete(key) {
      shared.delete(key);
    },
    async keys() {
      return [...shared.keys()];
    },
    async deleteMany(keys) {
      for (const key of keys) shared.delete(key);
    },
    async size() {
      return shared.size;
    },
  };

  const instanceA = createSsoStateStore({ backend, ttlMs: 1000, now: () => now });
  // Same backend, different process object: this is what "shared" has to mean.
  const instanceB = createSsoStateStore({ backend, ttlMs: 1000, now: () => now });

  assert.equal(instanceA.durable, true);
  assert.equal(instanceA.shared, true);

  const binding = 'd'.repeat(32);
  const state = await instanceA.create({ binding });

  // Created on one instance, consumed on another: a restart/multi-instance login flow.
  assert.equal(await instanceB.consume(state, binding), true);
  assert.equal(await instanceB.consume(state, binding), false, 'still single use across instances');

  // Expiry is honoured by a backend that does not prune itself.
  const expiring = await instanceA.create();
  now += 1001;
  assert.equal(await instanceB.consume(expiring), false);
});

test('a backend without keys() still works (get/set/delete is the minimum)', async () => {
  const map = new Map();
  const backend = {
    kind: 'minimal',
    async get(key) {
      return map.get(key);
    },
    async set(key, entry) {
      map.set(key, entry);
    },
    async delete(key) {
      map.delete(key);
    },
  };
  const store = createSsoStateStore({ backend });
  const state = await store.create({ binding: 'e'.repeat(32) });
  assert.equal(await store.consume(state, 'e'.repeat(32)), true);
  assert.equal(await store.stats().then((s) => s.pending), null);
});
