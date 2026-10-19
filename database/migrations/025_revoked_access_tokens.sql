-- Durable access-token revocation (S-04).
--
-- 018_sso_consumed_code.sql and 019_sso_shared_claim.sql are reserved by draft PR #35
-- and are not reused here. The ledger keys on the filename, so this file is 025.
--
-- Not applied to any host by this change.
-- Rollback: database/rollbacks/025_revoked_access_tokens.down.sql

CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  jti CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NOT NULL,
  PRIMARY KEY (jti),
  KEY idx_revoked_access_tokens_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
