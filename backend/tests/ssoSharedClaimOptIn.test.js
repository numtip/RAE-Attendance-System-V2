const assert = require('node:assert/strict');
const test = require('node:test');
const { HttpError } = require('../src/utils/httpError');
const { createOptInSharedStores } = require('../src/services/sso/ssoSharedClaimAdapter');
const { createSsoService } = require('../src/services/ssoService');
const { createMjuPortalGuard } = require('../src/services/sso/mjuPortalGuard');

test('shared claim opt-in without a pool fails closed', () => {
  assert.throws(
    () => createOptInSharedStores(null),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
});

test('shared claim database outage fails closed and does not use memory', async () => {
  const pool = {
    async query() {
      throw new Error('disposable outage');
    },
    async getConnection() {
      throw new Error('disposable outage');
    },
  };
  const stores = createOptInSharedStores(pool, { portalGuard: createMjuPortalGuard() });
  await assert.rejects(
    () => stores.stateStore.create({ binding: 'browser-binding-value' }),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
  await assert.rejects(
    () => stores.loginCodeStore.issue({ subject: 'synthetic' }),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
  await assert.rejects(
    () => stores.portalGuard.registerBinding('browser-binding-value'),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
});

test('default SSO service is unchanged when shared claims are not injected', async () => {
  const service = createSsoService({
    config: {
      jwt: { secret: 'test-only-secret', expiresIn: '15m', refreshTokenDays: 14 },
      sso: { enabled: false },
    },
    repositories: {},
  });
  await assert.rejects(
    () => service.beginLogin({}),
    (err) => err instanceof HttpError && err.code === 'SSO_DISABLED',
  );
});
