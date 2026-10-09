-- Manual rollback for 015 (NOT auto-applied: lives outside database/migrations/).
-- Precondition: take a backup first.
-- Refuses (aborts before dropping anything) if employee_identifier_secret holds rows (encrypted raw IDs)
-- — export/retire them under the retention policy first. The audit table is NEVER dropped here.
-- national_id lookup rows AND the nullable lookup_key_version column are kept on purpose: dropping the column
-- would erase which key produced each HMAC and make re-applying 015 impossible without a full reindex.


SET @secret_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_secret'
);
SET @secret_rows = IF(@secret_exists = 0, 0, 1);
SET @ddl = IF(@secret_exists = 0, 'SELECT 1',
  'SELECT COUNT(*) INTO @secret_rows FROM employee_identifier_secret');
PREPARE g1 FROM @ddl; EXECUTE g1; DEALLOCATE PREPARE g1;
SET @ddl = IF(@secret_rows > 0,
  'SELECT * FROM ABORT_rollback_secret_rows_exist_export_first', 'SELECT 1');
PREPARE g2 FROM @ddl; EXECUTE g2; DEALLOCATE PREPARE g2;

SET @key_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_national_owner'
);
SET @ddl = IF(@key_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP INDEX uk_employee_identifier_national_owner');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @owner_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'national_id_owner_uid'
);
SET @ddl = IF(@owner_col = 0, 'SELECT 1', 'ALTER TABLE employee_identifier DROP COLUMN national_id_owner_uid');
PREPARE r00 FROM @ddl; EXECUTE r00; DEALLOCATE PREPARE r00;

SET @chk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND CONSTRAINT_NAME = 'chk_employee_identifier_national_lookup' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl = IF(@chk_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP CONSTRAINT chk_employee_identifier_national_lookup');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

DROP TABLE IF EXISTS employee_identifier_secret;

DELETE FROM schema_migrations WHERE version = '015_employee_identifier_secure_lookup.sql';
