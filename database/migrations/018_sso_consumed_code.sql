-- Portal `ac` replay digests. Not applied to production by this branch.
-- Stores SHA-256 hex only. No employee, identifier, attendance, or leave rows.
-- Depends on schema_migrations (001) for the runner. Does not alter migration 017 or HIP tables.
-- Rollback while SSO is off: DROP TABLE sso_consumed_code and remove this version from schema_migrations.
-- There is no down-migration runner. A missing table must fail closed (503), never fall back to process memory.

CREATE TABLE IF NOT EXISTS sso_consumed_code (
  code_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  claimed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (code_digest),
  KEY idx_sso_consumed_code_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
