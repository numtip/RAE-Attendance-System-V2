const { randomBytes, createHash } = require('node:crypto');

const DEFAULT_BINDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

function digestOf(value) {
  return createHash('sha256').update(String(value)).digest();
}

function hexOf(value) {
  return digestOf(value).toString('hex');
}

/**
 * Callback protections for MJU's portal flow, which does not echo `state` (the sample has none):
 *
 *  1. Browser binding. /login registers the random value it also puts in an HttpOnly cookie. The callback must present
 *     that cookie, it is accepted once, and it expires. A callback that arrives in a browser that never started a login
 *     here (login CSRF / pasted callback URL) is refused before MJU is contacted. Residual risk: because MJU does not
 *     echo `state`, an attacker cannot be distinguished from MJU inside a browser that DID just start a login; that is
 *     bounded by the short TTL and by MJU rejecting a code it did not issue.
 *  2. Code replay. Each `ac` value is tried at most once per process (stored only as a SHA-256 digest). MJU's own
 *     single-use rule is UNKNOWN, so we do not depend on it.
 *
 * In-memory: does not survive a restart and is not shared between instances. Use a shared store before running more
 * than one backend instance.
 */
function createMjuPortalGuard({
  bindingTtlMs = DEFAULT_BINDING_TTL_MS,
  codeTtlMs = DEFAULT_CODE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const bindings = new Map(); // sha256 hex of binding -> expiresAt
  const codes = new Map(); // sha256 hex of ac -> expiresAt

  function prune(map) {
    const t = now();
    for (const [key, expiresAt] of map) {
      if (expiresAt <= t) map.delete(key);
    }
    while (map.size > MAX_ENTRIES) {
      map.delete(map.keys().next().value);
    }
  }

  return {
    /** A fresh, unguessable binding value (the controller generates its own; this exists for callers without one). */
    newBinding: () => randomBytes(24).toString('hex'),

    registerBinding(binding) {
      prune(bindings);
      bindings.set(hexOf(binding), now() + bindingTtlMs);
    },

    /** @returns {boolean} true only when this exact binding was registered, is unexpired and has not been used. */
    consumeBinding(binding) {
      prune(bindings);
      if (typeof binding !== 'string' || binding.length === 0) return false;
      const key = hexOf(binding);
      const known = bindings.has(key);
      bindings.delete(key); // burned on any attempt
      return known;
    },

    /** @returns {boolean} false when this `ac` was already tried. */
    claimCode(code) {
      prune(codes);
      const key = hexOf(code);
      if (codes.has(key)) return false;
      codes.set(key, now() + codeTtlMs);
      return true;
    },
  };
}

module.exports = { createMjuPortalGuard };
