-- Slice 3: provenance, completeness and idempotency for monthly_summary.
--
-- Why
--   * monthly_summary had no writer and no provenance. A month is DERIVED from the day rows, so it must be
--     able to say which rule versions contributed, when it was computed, and — most importantly — whether
--     it is COMPLETE. A month total that quietly averages over days nobody could judge is worse than no
--     total at all, because it looks authoritative.
--   * A month can legitimately span more than one rule version (the rule changes mid-month), so the rule
--     set is recorded rather than a single code.
--   * expected_working_days is separate from total_work_days on purpose. total_work_days counts the days
--     the rule actually classified as workdays in the stored rows; expected_working_days is what the
--     approved calendar says should have been worked. They differ when rows are missing, and that
--     difference IS the reconciliation signal.
--
-- Safety
--   * Additive and idempotent (information_schema-guarded); no existing column changed, no row rewritten.
--   * PRECONDITION for the unique key: monthly_summary must hold at most one row per
--     (employee_uid, year, month). It has no writer in this repository and the dev seed inserts exactly
--     one row per employee-month, so this holds; a guarded ALTER failure is the intended signal.
--   * No FK is added. monthly_summary predates the FK conventions used by later tables and adding one now
--     could reject historical rows.
--   * Not applied to any host by this change.
--
-- Rollback: database/rollbacks/024_monthly_summary_provenance.down.sql

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_024_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- 1. Completeness verdict. 'partial' means SOME days could not be judged; 'pending_policy' means the
--    blocker is a missing approved rule. Neither is ever presented as a final month total.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'computation_status'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary ADD COLUMN computation_status
     ENUM(''calculated'',''partial'',''pending_policy'',''no_data'',''failed'')
     NOT NULL DEFAULT ''calculated'' AFTER total_work_hours');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

-- 2. The rule versions that contributed. A JSON array because a month can span a rule change.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'rule_versions_json'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary ADD COLUMN rule_versions_json JSON NULL DEFAULT NULL AFTER computation_status');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

-- 3. expected_working_days is NULLABLE: NULL means "cannot be derived", never "zero". A month that cannot
--    be derived says so via derivation_notes instead of publishing a misleading 0.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'expected_working_days'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary ADD COLUMN expected_working_days INT(11) NULL DEFAULT NULL AFTER rule_versions_json');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;

-- 4. Day counts that the pre-existing columns cannot express.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'pending_days'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary
     ADD COLUMN pending_days INT(11) NOT NULL DEFAULT 0 AFTER expected_working_days,
     ADD COLUMN holiday_days INT(11) NOT NULL DEFAULT 0 AFTER pending_days,
     ADD COLUMN total_early_minutes INT(11) NOT NULL DEFAULT 0 AFTER holiday_days');
PREPARE s4 FROM @ddl; EXECUTE s4; DEALLOCATE PREPARE s4;

-- 5. Reviewer-facing detail: per-computation-status counts, the days missing a row, and why
--    expected_working_days is null when it is.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'day_counts_json'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary
     ADD COLUMN day_counts_json JSON NULL DEFAULT NULL AFTER total_early_minutes,
     ADD COLUMN derivation_notes TEXT NULL DEFAULT NULL AFTER day_counts_json,
     ADD COLUMN calculated_at DATETIME NULL DEFAULT NULL AFTER derivation_notes,
     ADD COLUMN source_kind VARCHAR(32) NOT NULL DEFAULT ''derived_from_daily_attendance'' AFTER calculated_at');
PREPARE s5 FROM @ddl; EXECUTE s5; DEALLOCATE PREPARE s5;

-- 6. Idempotency: one row per employee-month, so a re-derivation updates in place.
SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
    AND INDEX_NAME = 'uk_monthly_summary_employee_period'
);
SET @ddl = IF(@idx > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary ADD UNIQUE KEY uk_monthly_summary_employee_period (employee_uid, year, month)');
PREPARE s6 FROM @ddl; EXECUTE s6; DEALLOCATE PREPARE s6;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
    AND INDEX_NAME = 'idx_monthly_summary_computation_status'
);
SET @ddl = IF(@idx > 0, 'SELECT 1',
  'ALTER TABLE monthly_summary ADD KEY idx_monthly_summary_computation_status (computation_status)');
PREPARE s7 FROM @ddl; EXECUTE s7; DEALLOCATE PREPARE s7;
