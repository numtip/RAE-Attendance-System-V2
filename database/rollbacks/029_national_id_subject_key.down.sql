-- Local/operator rollback for 029. Drops the rotation-invariant guard only.
-- Removing it re-opens N-6: the same person can again exist twice across key versions.

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_national_subject'
);
SET @ddl = IF(@idx_exists > 0,
  'ALTER TABLE employee_identifier DROP INDEX uk_employee_identifier_national_subject',
  'SELECT 1');
PREPARE d0 FROM @ddl; EXECUTE d0; DEALLOCATE PREPARE d0;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND COLUMN_NAME = 'national_id_subject_key'
);
SET @ddl = IF(@col_exists > 0,
  'ALTER TABLE employee_identifier DROP COLUMN national_id_subject_key',
  'SELECT 1');
PREPARE d1 FROM @ddl; EXECUTE d1; DEALLOCATE PREPARE d1;

-- Clearing the ledger row is part of the rollback: the runner keys on the filename, so without it
-- `npm run db:migrate` believes this migration is still applied and the schema stays half rolled back.
DELETE FROM schema_migrations WHERE version = '029_national_id_subject_key.sql';
