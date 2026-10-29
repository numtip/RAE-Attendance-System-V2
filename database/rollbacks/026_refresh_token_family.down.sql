-- Rollback for 026_refresh_token_family.sql.
--
-- DATA LOSS, DELIBERATE AND IRREVERSIBLE: rows created after 026 store only a hash plus family
-- columns; their plaintext token was discarded on purpose. This rollback DELETEs those rows, so
-- every session issued after 026 ends immediately and those users must sign in again. Rows that
-- still hold a pre-026 plaintext token are kept.
--
-- Idempotent (corrected 2026-10-29): every DROP is guarded by information_schema. Before this
-- change a second run aborted with ERROR 1091 (Can't DROP INDEX ...), which left the table half
-- rolled back and looked like a partial failure.
--
-- Verified on a disposable MariaDB 11.4 database: first run reverses the DDL, second run is a no-op,
-- and re-applying the up migration restores the columns.

DELETE FROM refresh_tokens WHERE token IS NULL;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens'
    AND INDEX_NAME = 'idx_refresh_tokens_family_id'
);
SET @ddl = IF(@idx_exists = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens DROP INDEX idx_refresh_tokens_family_id');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens'
    AND INDEX_NAME = 'uk_refresh_tokens_token_hash'
);
SET @ddl = IF(@idx_exists = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens DROP INDEX uk_refresh_tokens_token_hash');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND COLUMN_NAME = 'parent_id'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens DROP COLUMN parent_id');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND COLUMN_NAME = 'family_id'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens DROP COLUMN family_id');
PREPARE r3 FROM @ddl; EXECUTE r3; DEALLOCATE PREPARE r3;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND COLUMN_NAME = 'token_hash'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens DROP COLUMN token_hash');
PREPARE r4 FROM @ddl; EXECUTE r4; DEALLOCATE PREPARE r4;

SET @still_nullable = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens'
    AND COLUMN_NAME = 'token' AND IS_NULLABLE = 'YES'
);
SET @ddl = IF(@still_nullable = 0, 'SELECT 1',
  'ALTER TABLE refresh_tokens MODIFY token VARCHAR(500) NOT NULL');
PREPARE r5 FROM @ddl; EXECUTE r5; DEALLOCATE PREPARE r5;

DELETE FROM schema_migrations WHERE version = '026_refresh_token_family.sql';
