const { createHash } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');

const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 60 * 60;

function digestHex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * MariaDB backend for the SSO login attempt store.
 *
 * WHY MARIADB: it is already the pilot's verified datastore — `mysql2`, `db/pool.js`,
 * `database/migrations/`, and a `backend-mariadb` CI job that runs a real MariaDB 11.4 service.
 * No new production service is introduced, and no Redis dependency is added.
 *
 * Two properties matter, and neither is optional:
 *
 *   1. ATOMIC SINGLE USE. `consume` holds the row with `SELECT ... FOR UPDATE`, deletes it, and
 *      only then reports the outcome. Two concurrent callbacks therefore cannot both win: the
 *      second blocks on the lock and then finds no row. A get-then-delete in JavaScript would let
 *      both see the row — exactly the double login this store exists to prevent.
 *   2. NO SILENT FALLBACK. Any database error other than "row not found" becomes
 *      `503 SSO_LOGIN_STORE_UNAVAILABLE`. Falling back to process memory would quietly restore
 *      the single-instance behaviour this table removes.
 *
 * The row is removed on EVERY presentation, valid or not, so a wrong binding cannot be retried.
 * Only SHA-256 digests are stored: neither the state value nor the browser binding is ever
 * written in plaintext, so the table cannot be read back into a usable cookie.
 */
function createMariaDbLoginAttemptBackend(pool, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
    throw new Error('MariaDB pool with getConnection() is required for the SSO login attempt store');
  }
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new Error('SSO login attempt TTL is out of range');
  }

  function unavailable() {
    return new HttpError(503, 'SSO_LOGIN_STORE_UNAVAILABLE', 'SSO login attempt store is unavailable');
  }

  return {
    kind: 'mariadb',
    durable: true,
    shared: true,
    ttlSeconds: ttl,

    /** @param {string} state @param {{expiresAt: number, bindingDigest: string|null}} entry */
    async set(state, entry) {
      if (typeof state !== 'string' || state.length === 0) {
        throw new Error('state is required');
      }
      if (!entry || typeof entry.expiresAt !== 'number') {
        throw new Error('login attempt entry requires expiresAt');
      }
      try {
        await pool.query(
          `INSERT INTO sso_login_attempt (state_digest, binding_digest, expires_at, created_at)
           VALUES (?, ?, FROM_UNIXTIME(?), UTC_TIMESTAMP(3))`,
          [digestHex(state), entry.bindingDigest ?? null, Math.floor(entry.expiresAt / 1000)],
        );
      } catch (error) {
        // A duplicate digest means a CSPRNG collision or a re-used value. Either way it must not
        // overwrite a pending attempt.
        throw unavailable(error);
      }
    },

    /** Look up without consuming. Used by diagnostics and legacy pruning only. */
    async get(state) {
      try {
        const [rows] = await pool.query(
          `SELECT binding_digest, expires_at
             FROM sso_login_attempt
            WHERE state_digest = ? AND expires_at > UTC_TIMESTAMP(3)
            LIMIT 1`,
          [digestHex(state)],
        );
        const row = rows && rows[0];
        if (!row) return undefined;
        return {
          expiresAt: new Date(row.expires_at).getTime(),
          bindingDigest: row.binding_digest ?? null,
        };
      } catch (error) {
        throw unavailable(error);
      }
    },

    async delete(state) {
      try {
        await pool.query('DELETE FROM sso_login_attempt WHERE state_digest = ?', [digestHex(state)]);
      } catch (error) {
        throw unavailable(error);
      }
    },

    /**
     * Atomically take the attempt out of the table.
     * @param {string} state
     * @returns {Promise<{status: 'ok'|'missing'|'expired', bindingDigest: string|null}>}
     */
    async consume(state) {
      if (typeof state !== 'string' || state.length === 0) {
        return { status: 'missing', bindingDigest: null };
      }
      const key = digestHex(state);
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // FOR UPDATE serialises concurrent consumers of the same attempt.
        const [rows] = await connection.query(
          `SELECT binding_digest, (expires_at > UTC_TIMESTAMP(3)) AS alive
             FROM sso_login_attempt
            WHERE state_digest = ?
            FOR UPDATE`,
          [key],
        );
        const row = rows && rows[0];

        // Removed whatever the outcome, inside the same transaction.
        await connection.query('DELETE FROM sso_login_attempt WHERE state_digest = ?', [key]);
        await connection.commit();

        if (!row) return { status: 'missing', bindingDigest: null };
        const alive = Number(row.alive) === 1 || row.alive === true;
        return { status: alive ? 'ok' : 'expired', bindingDigest: row.binding_digest ?? null };
      } catch {
        if (connection) {
          try {
            await connection.rollback();
          } catch {
            // A rollback failure must not mask the original failure.
          }
        }
        throw unavailable();
      } finally {
        if (connection) connection.release();
      }
    },

    /** Remove expired rows. Best effort: a failure here must not block a login. */
    async prune() {
      try {
        await pool.query('DELETE FROM sso_login_attempt WHERE expires_at <= UTC_TIMESTAMP(3)');
      } catch {
        // Housekeeping only. `consume` enforces expiry per row, so a skip is safe.
      }
    },

    async stats() {
      try {
        const [rows] = await pool.query(
          'SELECT COUNT(*) AS pending FROM sso_login_attempt WHERE expires_at > UTC_TIMESTAMP(3)',
        );
        return { pending: Number(rows?.[0]?.pending ?? 0), kind: 'mariadb' };
      } catch {
        return { pending: null, kind: 'mariadb' };
      }
    },
  };
}

module.exports = {
  createMariaDbLoginAttemptBackend,
  digestHex,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
};
