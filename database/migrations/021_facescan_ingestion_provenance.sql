-- Slice 1: file provenance for FaceScan/HIP CSV ingestion.
--
-- Why
--   * facescan_import_batches already records source_system, source_reference and the read/write
--     counters, but nothing ties a batch back to the exact file that produced it. A file can be
--     re-exported, edited or partially re-uploaded; without a content hash there is no way to prove
--     which bytes were imported or to detect a silent re-import of a changed file.
--   * input_sha256 is the SHA-256 of the raw input bytes; file_name is the operator-supplied name (no
--     path, so no host layout leaks into the database); parser_version records which adapter contract
--     interpreted the file; column_map_json records the header-to-field mapping that was used, so a
--     later change in the source export can be explained instead of guessed.
--
-- Non-goals: no normalized attendance, no daily_attendance writer, no rule math.
--
-- Safety
--   * Additive and idempotent (information_schema-guarded), no row rewritten, no table dropped.
--   * All four columns are NULLable, so existing rows and any code that does not set them keep working.
--   * Rollback: database/rollbacks/021_facescan_ingestion_provenance.down.sql

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'file_name'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches ADD COLUMN file_name VARCHAR(255) NULL DEFAULT NULL AFTER source_reference');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'input_sha256'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches ADD COLUMN input_sha256 CHAR(64) NULL DEFAULT NULL AFTER file_name');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'parser_version'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches ADD COLUMN parser_version VARCHAR(32) NULL DEFAULT NULL AFTER input_sha256');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches' AND COLUMN_NAME = 'column_map_json'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches ADD COLUMN column_map_json JSON NULL DEFAULT NULL AFTER parser_version');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facescan_import_batches'
    AND INDEX_NAME = 'idx_facescan_import_batches_input_sha'
);
SET @ddl = IF(@idx_exists > 0, 'SELECT 1',
  'ALTER TABLE facescan_import_batches ADD KEY idx_facescan_import_batches_input_sha (input_sha256)');
PREPARE s4 FROM @ddl; EXECUTE s4; DEALLOCATE PREPARE s4;
