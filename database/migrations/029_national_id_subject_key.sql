-- 029_national_id_subject_key.sql
--
-- N-6: a national-ID digest depends on the raw ID *and* the key version, so the existing uniqueness
--   * UNIQUE (id_type, id_value)          (013) - one digest, i.e. one version
--   * UNIQUE (national_id_owner_uid)      (015) - one national_id row per employee
-- cannot stop the same PERSON existing twice across a rotation: a v1 digest on employee B and a v2 digest
-- on employee C both insert, and both resolve.
--
-- This adds a rotation-invariant subject key: the digest of the canonical ID under a DEDICATED, never-rotating
-- index key (NATIONAL_ID_INDEX_KEY), stored in its own column with a global UNIQUE index.
--
-- WHY IT ABORTS WHEN ANY national_id ROW EXISTS
--   A stored digest cannot be reversed, so this migration cannot compute the subject key for an existing row.
--   Adding the column with NULLs and calling it protection would be security theatre: MariaDB allows many
--   NULLs in a unique index. The operator must backfill first with scripts/national-id-subject-backfill.mjs
--   (which needs the raw IDs from the source system), then apply this file. The abort message says exactly
--   that, and names the row count it saw.
--
-- NOT APPLIED TO ANY DATABASE by the agent that wrote it; proposals/029 is the design record.
-- Preflight (read-only): SELECT COUNT(*) FROM employee_identifier WHERE id_type = 'national_id';
-- Rollback: database/rollbacks/029_national_id_subject_key.down.sql
-- Requires MariaDB >= 10.2.3 (CHECK enforcement floor, same as 015) or MySQL >= 8.0.16.
-- DDL is not transactional.

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
  'SELECT * FROM ABORT_029_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- Refuse to install a guard that cannot cover the rows already present.
SET @national_rows = (
  SELECT COUNT(*) FROM employee_identifier WHERE id_type = 'national_id'
);
SET @ddl = IF(@national_rows = 0,
  'SELECT 1',
  'SELECT * FROM ABORT_029_backfill_required_run_scripts_national_id_subject_backfill_first');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND COLUMN_NAME = 'national_id_subject_key'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD COLUMN national_id_subject_key CHAR(64) NULL DEFAULT NULL AFTER lookup_key_version');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_national_subject'
);
SET @ddl = IF(@idx_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD UNIQUE KEY uk_employee_identifier_national_subject (national_id_subject_key)');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;
