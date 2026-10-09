-- Secure National ID storage (policy: docs/NATIONAL_ID_PROTECTION_POLICY.md). NOT applied to production by this PR.
--
-- Design
--   * employee_identifier.id_value for id_type='national_id' holds ONLY the lowercase hex HMAC-SHA-256
--     lookup (64 chars); never the raw ID. lookup_key_version records which HMAC key produced it.
--   * UNIQUE(id_type,id_value) (migration 013) dedupes within ONE key version. Different versions give
--     different HMACs, so the DB cannot see cross-version duplicates of the same person; guards:
--       - UNIQUE on national_id_owner_uid: at most one national_id row per employee (DB level);
--       - application: detectCrossVersionDuplicates() before insert, planReindex() for rotation.
--   * Raw ID storage is DISABLED by default; employee_identifier_secret stays empty unless a documented
--     necessity is approved. employee_identifier_access_audit is an append-only metadata log.
--
-- Safety
--   * Requires MariaDB >= 10.2.3 (CHECK enforcement + indexed generated column) or MySQL >= 8.0.16;
--     otherwise it aborts on the first statement, before any DDL. Tested on MariaDB 10.3 and 10.11.
--   * Idempotent: every step is guarded by information_schema / IF NOT EXISTS (the runner's
--     ledger is by filename only, and DDL auto-commits, so reruns after a partial failure must be safe).
--   * Backward compatible: new column is NULLable; other id_types are unaffected.
--   * Legacy plaintext: if any national_id row is not a 64-hex lookup with a key version, the CHECK step
--     fails. The only change left behind is the NULLable column; the ledger row is not written, so after
--     the approved reindex (planReindex) the same file is simply rerun. Run
--     database/preflight/015_preflight.sql first.
--   * DDL is not transactional; rollback = database/rollbacks/015_employee_identifier_secure_lookup.down.sql.

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_015_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

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

SET @owner_col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'national_id_owner_uid'
);
SET @ddl = IF(@owner_col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD COLUMN national_id_owner_uid VARCHAR(36)
     GENERATED ALWAYS AS (IF(id_type = ''national_id'', employee_uid, NULL)) STORED');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;

SET @owner_key_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_national_owner'
);
SET @ddl = IF(@owner_key_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD UNIQUE KEY uk_employee_identifier_national_owner (national_id_owner_uid)');
PREPARE s4 FROM @ddl; EXECUTE s4; DEALLOCATE PREPARE s4;

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
