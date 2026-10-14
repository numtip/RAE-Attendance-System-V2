-- Forward-only reconciliation for employee_identifier.
-- Not read by scripts/migrate.mjs (that runner only loads database/migrations/).
-- Does not edit 013_employee_identifier_foundation.sql or 013_personnel_identifier.sql.
-- Does not reorder an enum that already contains personnel_id.
-- Appends personnel_id only when that member is absent.
-- Safe to run more than once. Does not delete or rewrite identifier values.

ALTER TABLE employee_identifier
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(64) NULL DEFAULT NULL AFTER id_value,
  ADD COLUMN IF NOT EXISTS status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER is_primary,
  ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL DEFAULT NULL AFTER status;

SET @has_uk := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_type_value'
);
SET @sql_uk := IF(
  @has_uk = 0,
  'ALTER TABLE employee_identifier ADD UNIQUE KEY uk_employee_identifier_type_value (id_type, id_value)',
  'SELECT 1'
);
PREPARE stmt_uk FROM @sql_uk;
EXECUTE stmt_uk;
DEALLOCATE PREPARE stmt_uk;

ALTER TABLE employee_identifier
  ADD INDEX IF NOT EXISTS idx_employee_identifier_employee_type (employee_uid, id_type);

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employee_identifier'
    AND CONSTRAINT_NAME = 'fk_employee_identifier_employee'
);
SET @sql_fk := IF(
  @has_fk = 0,
  'ALTER TABLE employee_identifier ADD CONSTRAINT fk_employee_identifier_employee FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid)',
  'SELECT 1'
);
PREPARE stmt_fk FROM @sql_fk;
EXECUTE stmt_fk;
DEALLOCATE PREPARE stmt_fk;

SET @id_type := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employee_identifier'
    AND COLUMN_NAME = 'id_type'
);
SET @sql_enum := IF(
  @id_type LIKE '%personnel_id%',
  'SELECT 1',
  CONCAT(
    'ALTER TABLE employee_identifier MODIFY COLUMN id_type ',
    INSERT(@id_type, CHAR_LENGTH(@id_type), 0, ',''personnel_id'''),
    ' NOT NULL'
  )
);
PREPARE stmt_enum FROM @sql_enum;
EXECUTE stmt_enum;
DEALLOCATE PREPARE stmt_enum;
