-- Manual rollback for 015 (NOT auto-applied: lives outside database/migrations/).
-- Precondition: take a backup first. Dropping employee_identifier_secret destroys encrypted raw IDs;
-- dropping the audit table destroys audit history — export both before running if retention requires it.
-- national_id lookup rows are kept (they are HMAC values); only the version metadata and constraint go.

SET @chk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND CONSTRAINT_NAME = 'chk_employee_identifier_national_lookup' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl = IF(@chk_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP CONSTRAINT chk_employee_identifier_national_lookup');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

DROP TABLE IF EXISTS employee_identifier_secret;
-- DROP TABLE IF EXISTS employee_identifier_access_audit;  -- uncomment only after audit export

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'lookup_key_version'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1', 'ALTER TABLE employee_identifier DROP COLUMN lookup_key_version');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

DELETE FROM schema_migrations WHERE version = '015_employee_identifier_secure_lookup.sql';
