-- Secure National ID storage (policy: docs/NATIONAL_ID_PROTECTION_POLICY.md). NOT applied to production by this PR.
--
-- Design
--   * employee_identifier.id_value for id_type='national_id' holds ONLY the lowercase hex HMAC-SHA-256
--     lookup (64 chars); never the raw ID. lookup_key_version records which HMAC key produced it.
--     Existing UNIQUE (id_type, id_value) therefore enforces national-ID uniqueness per key version.
--   * Raw ID, only with an approved necessity, goes to employee_identifier_secret as AES-256-GCM
--     ciphertext (separate table => separate DB grants; separate key from the HMAC key).
--   * employee_identifier_access_audit is an append-only metadata log (no identifier values).
--
-- Safety
--   * Idempotent: every step is guarded by information_schema / IF NOT EXISTS.
--   * Backward compatible: new column is NULLable; other id_types are unaffected.
--   * Fails safely: the CHECK is added in one ALTER; if any existing national_id row is not a 64-hex
--     lookup (e.g. legacy plaintext) the ALTER aborts and nothing changes. Run
--     database/preflight/015_preflight.sql first; it must return 0 in every column.
--   * DDL is not transactional in MariaDB; recovery = rerun this file (idempotent) or apply
--     database/rollbacks/015_employee_identifier_secure_lookup.down.sql.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'lookup_key_version'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD COLUMN lookup_key_version SMALLINT UNSIGNED NULL DEFAULT NULL AFTER id_value');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @chk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND CONSTRAINT_NAME = 'chk_employee_identifier_national_lookup' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl = IF(@chk_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD CONSTRAINT chk_employee_identifier_national_lookup CHECK (
     id_type <> ''national_id''
     OR (lookup_key_version IS NOT NULL AND id_value REGEXP ''^[0-9a-f]{64}$'')
   )');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

CREATE TABLE IF NOT EXISTS employee_identifier_secret (
  id INT(11) NOT NULL AUTO_INCREMENT,
  identifier_id INT(11) NOT NULL,
  ciphertext VARBINARY(64) NOT NULL,
  iv BINARY(12) NOT NULL,
  auth_tag BINARY(16) NOT NULL,
  enc_key_id VARCHAR(64) NOT NULL,
  necessity_ref VARCHAR(128) NOT NULL,
  retain_until DATE NOT NULL,
  created_by VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_identifier_secret_identifier (identifier_id),
  KEY idx_identifier_secret_key (enc_key_id),
  KEY idx_identifier_secret_retain (retain_until),
  CONSTRAINT fk_identifier_secret_identifier
    FOREIGN KEY (identifier_id) REFERENCES employee_identifier (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_identifier_access_audit (
  id BIGINT NOT NULL AUTO_INCREMENT,
  identifier_id INT(11) NULL,
  employee_uid VARCHAR(36) NULL,
  action ENUM('lookup', 'create', 'decrypt', 'reindex', 'delete', 'key_rotation') NOT NULL,
  key_version SMALLINT UNSIGNED NULL,
  actor VARCHAR(128) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_identifier_audit_identifier (identifier_id),
  KEY idx_identifier_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
