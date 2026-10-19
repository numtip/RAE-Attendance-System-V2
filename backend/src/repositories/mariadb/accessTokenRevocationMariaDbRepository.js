function createAccessTokenRevocationMariaDbRepository(pool) {
  return {
    async revoke(record) {
      if (!record?.jti || !record.expiresAt) {
        throw new Error('revocation record requires jti and expiresAt');
      }
      await pool.query(
        `INSERT INTO revoked_access_tokens (jti, expires_at, revoked_at)
         VALUES (?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE revoked_at = revoked_at`,
        [record.jti, new Date(record.expiresAt)],
      );
    },
    async isRevoked(jti) {
      const [rows] = await pool.query(
        `SELECT jti FROM revoked_access_tokens WHERE jti = ? LIMIT 1`,
        [jti],
      );
      return rows.length > 0;
    },
  };
}

module.exports = { createAccessTokenRevocationMariaDbRepository };
