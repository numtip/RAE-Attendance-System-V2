import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { createMemoryAttemptStore } from './attemptStore.js';
import { createSharedAttemptStore } from './sharedAttemptStore.js';
import { createMemorySessionStore, DEFAULT_SESSION_TTL_MS } from './sessionStore.js';
import { createDurableSessionStore } from './durableSessionStore.js';
import { createFileDriver } from './fileDriver.js';
import { createRedisDriver } from './redisDriver.js';

/**
 * Store selection by configuration, with one rule that matters more than the default:
 *
 *   A CONFIGURED DURABLE DRIVER THAT IS UNAVAILABLE IS A STARTUP FAILURE, NEVER A SILENT FALLBACK.
 *
 * The bug this whole change exists for is invisible: an in-memory store works perfectly on one
 * process until the process restarts, at which point every session disappears and every consumed
 * `ac` becomes replayable on the next worker. A store that "falls back to memory when Redis is
 * down" reproduces exactly that, with the added harm that it looks configured. So there is one
 * branch per driver and no fallback branch: if `redis` is selected, the driver is built and PINGed,
 * and an unreachable server throws out of `createStoresFromConfig`.
 *
 * The default is `memory`, because that is what every existing test and a single-process
 * development run depend on, and changing the default would be a behavioural change no operator
 * asked for. It is NOT a production default: `MJU_SSO_STORE_REQUIRE_DURABLE=true` makes an
 * operator state that this deployment must have a durable store, and then the memory driver is
 * refused at startup.
 *
 * Nothing here reads a credential from anywhere but the environment, and `describe()` returns the
 * driver name and whether it is durable — never a password, a socket path or a key prefix.
 */

export const STORE_DRIVER = Object.freeze({
  MEMORY: 'memory',
  FILE: 'file',
  REDIS: 'redis',
});

export const STORE_ENV_KEYS = Object.freeze([
  'MJU_SSO_STORE_DRIVER',
  'MJU_SSO_STORE_REQUIRE_DURABLE',
  'MJU_SSO_STORE_FILE_ROOT',
  'MJU_SSO_STORE_REDIS_SOCKET',
  'MJU_SSO_STORE_REDIS_HOST',
  'MJU_SSO_STORE_REDIS_PORT',
  'MJU_SSO_STORE_REDIS_USERNAME',
  'MJU_SSO_STORE_REDIS_PASSWORD',
  'MJU_SSO_STORE_REDIS_DB',
  'MJU_SSO_STORE_KEY_PREFIX',
  'MJU_SSO_STORE_SESSION_TTL_MS',
]);

function text(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Ambiguity is refused: a flag that is neither true nor false must not be read as false. */
function flag(env, name) {
  const value = text(env, name).toLowerCase();
  if (value === '') return false;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
    status: 500,
    message: `${name} must be true or false`,
  });
}

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = text(env, name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: `${name} must be an integer between ${min} and ${max}`,
    });
  }
  return value;
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveStoreConfig(env = {}) {
  const requested = text(env, 'MJU_SSO_STORE_DRIVER').toLowerCase();
  const driver = requested === '' ? STORE_DRIVER.MEMORY : requested;
  const requireDurable = flag(env, 'MJU_SSO_STORE_REQUIRE_DURABLE');

  if (!Object.values(STORE_DRIVER).includes(driver)) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: `MJU_SSO_STORE_DRIVER must be one of ${Object.values(STORE_DRIVER).join(', ')}`,
    });
  }

  if (requireDurable && driver === STORE_DRIVER.MEMORY) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A durable store is required, but the memory driver (single process, dies on restart) is selected',
    });
  }

  const keyPrefix = text(env, 'MJU_SSO_STORE_KEY_PREFIX') || 'mju-sso:';
  if (!keyPrefix.endsWith(':')) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'MJU_SSO_STORE_KEY_PREFIX must end with ":" so namespaces cannot collide by prefix',
    });
  }

  const sessionTtlMs = integer(env, 'MJU_SSO_STORE_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS, {
    min: 1_000,
    max: 7 * 24 * 60 * 60 * 1000,
  });

  if (driver === STORE_DRIVER.FILE) {
    const root = text(env, 'MJU_SSO_STORE_FILE_ROOT');
    if (root === '') {
      // A default would be "the current directory", which is a way to scatter credentials into a
      // checkout. The directory is named explicitly or the driver is not used.
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 500,
        message: 'MJU_SSO_STORE_FILE_ROOT is required when MJU_SSO_STORE_DRIVER=file',
      });
    }
    return { driver, durable: true, requireDurable, keyPrefix, sessionTtlMs, file: { root } };
  }

  if (driver === STORE_DRIVER.REDIS) {
    return {
      driver,
      durable: true,
      requireDurable,
      keyPrefix,
      sessionTtlMs,
      redis: {
        socketPath: text(env, 'MJU_SSO_STORE_REDIS_SOCKET') || undefined,
        host: text(env, 'MJU_SSO_STORE_REDIS_HOST') || '127.0.0.1',
        port: integer(env, 'MJU_SSO_STORE_REDIS_PORT', 6379, { min: 1, max: 65_535 }),
        username: text(env, 'MJU_SSO_STORE_REDIS_USERNAME') || undefined,
        password: text(env, 'MJU_SSO_STORE_REDIS_PASSWORD') || undefined,
        db: integer(env, 'MJU_SSO_STORE_REDIS_DB', 0, { min: 0, max: 1024 }),
      },
    };
  }

  return { driver: STORE_DRIVER.MEMORY, durable: false, requireDurable, keyPrefix, sessionTtlMs };
}

/**
 * Build the store pair a deployment runs on.
 *
 * The attempt store and the session store share ONE driver instance: one connection, one
 * namespace, one thing to monitor. They use different key prefixes (`attempt:`, `code:`, `sess:`),
 * so a shared instance still cannot confuse a session id with a code.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{sessionTtlMs?: number, attemptTtlMs?: number, codeTtlMs?: number}} [policy]
 */
export async function createStoresFromConfig(env = {}, policy = {}) {
  const config = resolveStoreConfig(env);
  const sessionTtlMs = policy.sessionTtlMs ?? config.sessionTtlMs;

  if (config.driver === STORE_DRIVER.MEMORY) {
    return {
      driver: config.driver,
      durable: false,
      sessions: createMemorySessionStore({ ttlMs: sessionTtlMs }),
      attempts: createMemoryAttemptStore(),
      describe: () => ({ driver: config.driver, durable: false }),
      close: () => {},
    };
  }

  const driver =
    config.driver === STORE_DRIVER.FILE
      ? createFileDriver({ root: config.file.root })
      : await createRedisDriver(config.redis);

  const sessions = createDurableSessionStore({
    driver,
    ttlMs: sessionTtlMs,
    keyPrefix: config.keyPrefix,
  });
  const attempts = createSharedAttemptStore({
    driver,
    keyPrefix: config.keyPrefix,
    ...(Number.isInteger(policy.attemptTtlMs) ? { attemptTtlMs: policy.attemptTtlMs } : {}),
    ...(Number.isInteger(policy.codeTtlMs) ? { codeTtlMs: policy.codeTtlMs } : {}),
  });

  return {
    driver: config.driver,
    durable: true,
    sessions,
    attempts,
    describe: () => ({ driver: config.driver, durable: true }),
    close() {
      if (typeof driver.close === 'function') driver.close();
    },
  };
}
