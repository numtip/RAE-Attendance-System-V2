-- Rollback for 024_monthly_summary_provenance.sql.
-- Removes the provenance, completeness and idempotency changes from monthly_summary.
-- WARNING: this discards the completeness verdict, the contributing rule versions, expected_working_days
-- and the derivation notes of every stored month, and cannot restore them. Export first:
--   SELECT * FROM monthly_summary;
-- The pre-existing aggregate columns (total_*) are left exactly as they are, so a rolled-back database
-- keeps its month totals but loses the ability to say how complete or how derived they were.
-- Idempotent: safe to run when part of the migration was already reversed.

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
    AND INDEX_NAME = 'idx_monthly_summary_computation_status'
);
SET @ddl = IF(@idx = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary DROP KEY idx_monthly_summary_computation_status');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
    AND INDEX_NAME = 'uk_monthly_summary_employee_period'
);
SET @ddl = IF(@idx = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary DROP KEY uk_monthly_summary_employee_period');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'source_kind'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary
     DROP COLUMN source_kind,
     DROP COLUMN calculated_at,
     DROP COLUMN derivation_notes,
     DROP COLUMN day_counts_json');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'total_early_minutes'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary
     DROP COLUMN total_early_minutes,
     DROP COLUMN holiday_days,
     DROP COLUMN pending_days');
PREPARE r3 FROM @ddl; EXECUTE r3; DEALLOCATE PREPARE r3;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'expected_working_days'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary DROP COLUMN expected_working_days');
PREPARE r4 FROM @ddl; EXECUTE r4; DEALLOCATE PREPARE r4;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'rule_versions_json'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary DROP COLUMN rule_versions_json');
PREPARE r5 FROM @ddl; EXECUTE r5; DEALLOCATE PREPARE r5;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'computation_status'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE monthly_summary DROP COLUMN computation_status');
PREPARE r6 FROM @ddl; EXECUTE r6; DEALLOCATE PREPARE r6;
