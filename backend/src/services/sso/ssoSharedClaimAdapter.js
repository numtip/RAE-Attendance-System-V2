const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');
const {
  createMariaDbSharedClaimStore,
  BINDING_TTL_SECONDS,
  HANDOFF_TTL_SECONDS,
} = require('./mariadbSharedClaimStore');

function unavailable() {
  return new HttpError(503, 'SSO_SHARED_STORE_UNAVAILABLE', 'SSO shared claim store is not configured');
}

function digestHex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Explicit opt-in. There is no in-memory fallback.
 * @param {import('mysql2/promise').Pool} pool
 */
function createOptInSharedStores(pool, {
  bindingTtlSeconds = BINDING_TTL_SECONDS,
  handoffTtlSeconds = HANDOFF_TTL_SECONDS,
  portalGuard: innerGuard = null,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw unavailable();
  }
  const binding = createMariaDbSharedClaimStore(pool, { kind: 'binding', ttlSeconds: bindingTtlSeconds });
  const handoff = createMariaDbSharedClaimStore(pool, { kind: 'handoff', ttlSeconds: handoffTtlSeconds });

  const stateStore = {
    async create({ binding: browserBinding } = {}) {
      const state = randomBytes(24).toString('hex');
      await binding.put(state, { bindingDigest: browserBinding ? digestHex(browserBinding) : null });
      return state;
    },
    async consume(state, browserBinding) {
      const result = await binding.consume(state);
      if (result.status !== 'ok') return false;
      const expected = result.payload && result.payload.bindingDigest;
      if (!expected) return true;
      if (typeof browserBinding !== 'string' || browserBinding.length === 0) return false;
      const actual = digestHex(browserBinding);
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
    },
  };

  const loginCodeStore = {
    async issue(payload) {
      const code = randomBytes(24).toString('hex');
      await handoff.put(code, payload);
      return code;
    },
    peek: (code) => handoff.peek(code),
    consume: (code) => handoff.consume(code),
  };

  const portalGuard = innerGuard ? {
    newBinding: () => innerGuard.newBinding(),
    async registerBinding(value) {
      await binding.put(`portal-bind:${value}`, { registered: true });
    },
    async consumeBinding(value) {
      if (typeof value !== 'string' || value.length === 0) return false;
      const result = await binding.consume(`portal-bind:${value}`);
      return result.status === 'ok';
    },
    claimCode: (code) => innerGuard.claimCode(code),
  } : null;

  return { stateStore, loginCodeStore, portalGuard };
}

module.exports = { createOptInSharedStores };
