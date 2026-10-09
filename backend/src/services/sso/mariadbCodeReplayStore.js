const { createHash } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');

const DEFAULT_TTL_SECONDS = 60 * 60;

function digestHex(code) {
  return createHash('sha256').update(String(code), 'utf8').digest('hex');
}

function isDuplicate(error) {
  return Boolean(error) && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

/**
 * Shared replay store. One INSERT owns the digest. A duplicate key is a replay.
 * Any other database error is fail-closed and must not fall back to process memory.
 * The raw `ac` is never written.
 */
function createMariaDbCodeReplayStore(pool, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('MariaDB pool is required for the SSO replay store');
  }
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60) {
    throw new Error('SSO replay TTL is out of range');
  }

  return {
    async claim(code) {
      if (typeof code !== 'string' || code.length === 0) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'ac is required');
      }
      const digest = digestHex(code);
      try {
        await pool.query('DELETE FROM sso_consumed_code WHERE expires_at <= UTC_TIMESTAMP(3)');
        await pool.query(
          `INSERT INTO sso_consumed_code (code_digest, expires_at, claimed_at)
           VALUES (?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), UTC_TIMESTAMP(3))`,
          [digest, ttl],
        );
        return true;
      } catch (error) {
        if (isDuplicate(error)) return false;
        throw new HttpError(503, 'SSO_REPLAY_STORE_UNAVAILABLE', 'SSO replay store did not accept the claim');
      }
    },
  };
}

module.exports = { createMariaDbCodeReplayStore, digestHex, DEFAULT_TTL_SECONDS };
