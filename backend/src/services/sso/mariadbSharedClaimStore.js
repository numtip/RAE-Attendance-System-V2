const { createHash } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');

const BINDING_TTL_SECONDS = 10 * 60;
const HANDOFF_TTL_SECONDS = 45;

const SHARED_CLAIM_DDL = `
CREATE TABLE IF NOT EXISTS sso_shared_claim (
  claim_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('binding', 'handoff') NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (claim_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

function digestHex(code) {
  return createHash('sha256').update(String(code), 'utf8').digest('hex');
}

function isDuplicate(error) {
  return Boolean(error) && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

function unavailable() {
  return new HttpError(503, 'SSO_SHARED_STORE_UNAVAILABLE', 'SSO shared claim store did not accept the request');
}

/**
 * Multi-process binding and login-handoff store.
 * One INSERT owns the digest. Consume is one UPDATE of an unconsumed, unexpired row.
 * Database errors fail closed. This module never falls back to process memory.
 * The raw code is never written. Not wired into the production SSO service.
 */
function createMariaDbSharedClaimStore(pool, { kind, ttlSeconds } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
    throw new Error('MariaDB pool is required for the SSO shared claim store');
  }
  if (kind !== 'binding' && kind !== 'handoff') {
    throw new Error('SSO shared claim kind must be binding or handoff');
  }
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60) {
    throw new Error('SSO shared claim TTL is out of range');
  }

  async function readPayload(executor, digest) {
    const [rows] = await executor.query(
      `SELECT payload_json, consumed_at,
              (expires_at > UTC_TIMESTAMP(3)) AS live
       FROM sso_shared_claim
       WHERE claim_digest = ? AND kind = ?`,
      [digest, kind],
    );
    return rows[0] || null;
  }

  return {
    async put(code, payload) {
      if (typeof code !== 'string' || code.length === 0) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'claim code is required');
      }
      const digest = digestHex(code);
      let body;
      try {
        body = JSON.stringify(payload);
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'claim payload is not serializable');
      }
      try {
        await pool.query('DELETE FROM sso_shared_claim WHERE expires_at <= UTC_TIMESTAMP(3) AND consumed_at IS NULL');
        await pool.query(
          `INSERT INTO sso_shared_claim (claim_digest, kind, payload_json, expires_at)
           VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
          [digest, kind, body, ttl],
        );
      } catch (error) {
        if (isDuplicate(error)) {
          throw new HttpError(409, 'SSO_CLAIM_REPLAY', 'claim code was already stored');
        }
        throw unavailable();
      }
    },

    async peek(code) {
      if (typeof code !== 'string' || code.length === 0) {
        return { status: 'unknown' };
      }
      try {
        const row = await readPayload(pool, digestHex(code));
        if (!row) return { status: 'unknown' };
        if (row.consumed_at) return { status: 'unknown' };
        if (!row.live) return { status: 'expired' };
        return { status: 'ok', payload: JSON.parse(row.payload_json) };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw unavailable();
      }
    },

    async consume(code) {
      if (typeof code !== 'string' || code.length === 0) {
        return { status: 'unknown' };
      }
      const digest = digestHex(code);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [updated] = await conn.query(
          `UPDATE sso_shared_claim
           SET consumed_at = UTC_TIMESTAMP(3)
           WHERE claim_digest = ? AND kind = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
          [digest, kind],
        );
        if (updated.affectedRows !== 1) {
          const row = await readPayload(conn, digest);
          await conn.rollback();
          if (row && !row.consumed_at && !row.live) return { status: 'expired' };
          return { status: 'unknown' };
        }
        const row = await readPayload(conn, digest);
        await conn.commit();
        return { status: 'ok', payload: JSON.parse(row.payload_json) };
      } catch (error) {
        try { await conn.rollback(); } catch { /* fail closed below */ }
        if (error instanceof HttpError) throw error;
        throw unavailable();
      } finally {
        conn.release();
      }
    },
  };
}

module.exports = {
  createMariaDbSharedClaimStore,
  SHARED_CLAIM_DDL,
  digestHex,
  BINDING_TTL_SECONDS,
  HANDOFF_TTL_SECONDS,
};
