-- Add the MJU Person API personnel identifier without changing existing values.
-- The guards make recovery from a partially applied ALTER safe to rerun.

SET @personnel_id_supported = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employee_identifier'
    AND COLUMN_NAME = 'id_type'
    AND COLUMN_TYPE LIKE '%''personnel_id''%'
);
SET @ddl = IF(
  @personnel_id_supported > 0,
  'SELECT 1',
  'ALTER TABLE employee_identifier
     MODIFY id_type ENUM(
       ''facescan_id'',
       ''national_id'',
       ''employee_id'',
       ''personnel_id''
     ) NOT NULL'
);
PREPARE personnel_id_statement FROM @ddl;
EXECUTE personnel_id_statement;
DEALLOCATE PREPARE personnel_id_statement;

SET @identifier_unique_key_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'uk_employee_identifier_type_value'
);
SET @ddl = IF(
  @identifier_unique_key_exists > 0,
  'SELECT 1',
  'ALTER TABLE employee_identifier
     ADD UNIQUE KEY uk_employee_identifier_type_value (id_type, id_value)'
);
PREPARE identifier_unique_statement FROM @ddl;
EXECUTE identifier_unique_statement;
DEALLOCATE PREPARE identifier_unique_statement;

-- Rollback path (only while no personnel_id rows exist):
-- ALTER TABLE employee_identifier
--   DROP INDEX uk_employee_identifier_type_value,
--   MODIFY id_type ENUM('facescan_id', 'national_id', 'employee_id') NOT NULL;
