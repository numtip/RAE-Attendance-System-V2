import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { createRedisClient } from './redisClient.js';

/**
 * Redis driver for the durable attempt and session stores (see `docs/ADR/ADR-008-durable-session-store.md`).
 *
 * Every primitive is ONE command, because the atomicity has to come from the server:
 *
 *   setIfAbsent  SET key value PX ttl NX   — creates only if absent, with a server-side expiry
 *   take         GETDEL key                — returns the value and deletes it in one step
 *                (falls back to one Lua EVAL on servers older than 6.2; still one round trip)
 *   get          GET key
 *
 * A get-then-del pair would let two workers both read a binding before either deleted it, which is
 * the exact replay the store exists to refuse. There is no read-modify-write in this file.
 *
 * NO `count()`. A prefix count on Redis means SCAN (O(n), and O(n) on the login path), or a counter
 * key that has to be kept consistent with every TTL. Rather than pretend, this driver omits the
 * primitive, and `createSharedAttemptStore` reports `ceilingEnforced: false` for it. Growth is
 * bounded by the TTLs, not by a ceiling.
 *
 * `createRedisDriver` is async and PINGs once: a configured-but-unreachable store must fail at
 * construction, not at the first callback. There is no retry-to-memory path anywhere.
 */

const TAKE_SCRIPT = "local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v";

/**
 * @param {{
 *   socketPath?: string,
 *   host?: string,
 *   port?: number,
 *   password?: string,
 *   username?: string,
 *   db?: number,
 *   connectTimeoutMs?: number,
 *   commandTimeoutMs?: number,
 * }} [options]
 */
export async function createRedisDriver(options = {}) {
  const client = createRedisClient(options);

  try {
    const pong = await client.command('PING');
    if (pong !== 'PONG') throw new Error('redis: unexpected PING reply');
  } catch (error) {
    client.close();
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: `The configured store is not reachable: ${error.code ?? error.message}`,
    });
  }

  // Older servers have no GETDEL. Probe once, then remember, so the fallback is not two commands
  // per consume.
  let useGetDel = true;

  return {
    kind: 'redis',

    async setIfAbsent(key, value, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
          status: 500,
          message: 'A stored record needs a positive TTL in milliseconds',
        });
      }
      const reply = await client.command('SET', key, value, 'PX', String(Math.ceil(ttlMs)), 'NX');
      return reply === 'OK';
    },

    async get(key) {
      const reply = await client.command('GET', key);
      return typeof reply === 'string' ? reply : null;
    },

    async take(key) {
      if (useGetDel) {
        try {
          const reply = await client.command('GETDEL', key);
          return typeof reply === 'string' ? reply : null;
        } catch (error) {
          if (error.redis !== true || !/unknown command/i.test(error.message)) throw error;
          useGetDel = false;
        }
      }
      const reply = await client.command('EVAL', TAKE_SCRIPT, '1', key);
      return typeof reply === 'string' ? reply : null;
    },

    async ping() {
      return client.command('PING');
    },

    close() {
      client.close();
    },
  };
}
