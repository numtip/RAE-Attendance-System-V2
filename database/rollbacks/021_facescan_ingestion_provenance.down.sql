-- Rollback for 021_facescan_ingestion_provenance.sql.
-- Removes the file-provenance columns. Import-batch history is lost for those columns only; the batch
-- rows and the staged events themselves are untouched.
-- Idempotent: safe to run when part of the migration was already reversed.

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches'
    AND INDEX_NAME = 'idx_facescan_import_batches_input_sha'
);
SET @ddl = IF(@idx_exists = 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches DROP KEY idx_facescan_import_batches_input_sha');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'column_map_json'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches DROP COLUMN column_map_json');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'parser_version'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches DROP COLUMN parser_version');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'input_sha256'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches DROP COLUMN input_sha256');
PREPARE r3 FROM @ddl; EXECUTE r3; DEALLOCATE PREPARE r3;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'file_name'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches DROP COLUMN file_name');
PREPARE r4 FROM @ddl; EXECUTE r4; DEALLOCATE PREPARE r4;
