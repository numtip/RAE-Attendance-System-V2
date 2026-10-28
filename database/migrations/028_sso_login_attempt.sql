-- SSO login attempt store (G-02: shared, durable, bindable).
--
-- One row per pending login. Stores SHA-256 digests only: neither the state value nor the
-- browser binding is ever written in plaintext, so the table cannot be read back into a usable
-- cookie.
--
-- 018_sso_consumed_code.sql and 019_sso_shared_claim.sql are reserved by draft PR #35 and are
-- not reused here. The ledger keys on the filename, so this file is 028.
--
-- Not applied to any host by this change.
-- Rollback: database/rollbacks/028_sso_login_attempt.down.sql
--
-- A missing table must FAIL CLOSED (503): never fall back to process memory, because that would
-- silently restore the single-instance behaviour this table exists to remove.

CREATE TABLE IF NOT EXISTS sso_login_attempt (
  state_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- NULL only for a caller that deliberately creates an unbound attempt (direct service use in
  -- tests). An unbound attempt is never satisfied by presenting a binding.
  binding_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (state_digest),
  KEY idx_sso_login_attempt_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
