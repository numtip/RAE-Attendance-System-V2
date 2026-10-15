-- Rollback for 020_employee_assignment_effective_dating.sql.
-- Reverses the DDL only. Any employee_assignment rows are dropped with the table, so export them first
-- if they carry real history:  SELECT * FROM employee_assignment;
-- Idempotent: safe to run when part of the migration was already reversed.

DROP TABLE IF EXISTS employee_assignment;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'idx_employee_identifier_effective'
);
SET @ddl = IF(@idx_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP KEY idx_employee_identifier_effective');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'effective_to'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP COLUMN effective_to');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'effective_from'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier DROP COLUMN effective_from');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

SET @action_type = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_access_audit'
    AND COLUMN_NAME = 'action'
);
SET @ddl = IF(@action_type IS NULL OR @action_type NOT LIKE '%effective_change%', 'SELECT 1',
  'ALTER TABLE employee_identifier_access_audit
     MODIFY COLUMN action ENUM(''lookup'',''create'',''decrypt'',''reindex'',''delete'',''key_rotation'') NOT NULL');
PREPARE r3 FROM @ddl; EXECUTE r3; DEALLOCATE PREPARE r3;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_access_audit'
    AND COLUMN_NAME = 'effective_to'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier_access_audit DROP COLUMN effective_to');
PREPARE r4 FROM @ddl; EXECUTE r4; DEALLOCATE PREPARE r4;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_access_audit'
    AND COLUMN_NAME = 'effective_from'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identifier_access_audit DROP COLUMN effective_from');
PREPARE r5 FROM @ddl; EXECUTE r5; DEALLOCATE PREPARE r5;
