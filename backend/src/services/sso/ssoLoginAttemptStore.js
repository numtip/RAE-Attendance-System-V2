const { HttpError } = require('../../utils/httpError');
const { createSsoStateStore } = require('./ssoStateStore');
const { createMariaDbLoginAttemptBackend, DEFAULT_TTL_SECONDS: MARIADB_DEFAULT_TTL } = require('./mariadbLoginAttemptBackend');

const MODES = ['mariadb', 'memory'];

/**
 * Chooses the SSO login attempt store for this deployment.
 *
 * DECISION (recorded, not assumed): the shared store is MariaDB, because MariaDB is already the
 * pilot's verified datastore and CI runs a real MariaDB 11.4 service against the migrations. That
 * satisfies "prefer existing infrastructure" and introduces no new production service. Redis is
 * not a dependency of this project and adding one for a 10-minute attempt would be new operational
 * surface for no gain.
 *
 * FAIL-CLOSED RULES:
 *   - `memory` is refused when SSO is enabled in production. A process-local store cannot see a
 *     login started on another instance and forgets every pending attempt on restart, so it would
 *     silently undo the point of this change.
 *   - `mariadb` without a usable pool is refused at construction when SSO is enabled.
 *   - A database error at runtime surfaces as 503 from the backend; there is no fallback path.
 *
 * An `SSO_LOGIN_ATTEMPT_STORE=memory` deployment is legitimate for a single-process staging box,
 * but it must be stated explicitly rather than inferred.
 *
 * @param {{config: object, pool?: object}} input
 */
function createLoginAttemptStore({ config, pool } = {}) {
  const sso = config?.sso ?? {};
  const production = config?.env === 'production';
  const ttlMs = Number(sso.loginBindingTtlMs ?? 10 * 60 * 1000);

  const requested = String(sso.loginAttemptStore ?? '').trim().toLowerCase();
  if (requested && !MODES.includes(requested)) {
    throw new HttpError(
      503,
      'CONFIG_ERROR',
      `SSO_LOGIN_ATTEMPT_STORE must be one of: ${MODES.join(', ')}`,
    );
  }

  // An unset value follows the deployment: MariaDB when a pool exists, otherwise memory.
  const mode = requested || (pool ? 'mariadb' : 'memory');

  if (mode === 'memory') {
    if (production && sso.enabled) {
      throw new HttpError(
        503,
        'CONFIG_ERROR',
        'SSO_LOGIN_ATTEMPT_STORE=memory cannot be enabled in production; use mariadb',
      );
    }
    return createSsoStateStore({ ttlMs });
  }

  if (!pool) {
    if (!sso.enabled) {
      // SSO is off, so the store is unreachable. Keep startup alive rather than failing a boot
      // for a subsystem nobody enabled. Nothing can read this store.
      return createSsoStateStore({ ttlMs });
    }
    throw new HttpError(
      503,
      'CONFIG_ERROR',
      'SSO is enabled but no database pool is available for the login attempt store',
    );
  }

  const backend = createMariaDbLoginAttemptBackend(pool, {
    ttlSeconds: Math.max(1, Math.min(Math.round(ttlMs / 1000), MARIADB_DEFAULT_TTL * 6)),
  });
  return createSsoStateStore({ ttlMs, backend });
}

/** Redacted description for logs and health output. Never contains a secret. */
function describeLoginAttemptStore(store) {
  return {
    kind: store?.kind ?? 'unknown',
    durable: store?.durable === true,
    shared: store?.shared === true,
    // The honest headline: a non-shared store only works for one process.
    multiInstanceSafe: store?.shared === true,
  };
}

module.exports = {
  createLoginAttemptStore,
  describeLoginAttemptStore,
  MODES,
};
