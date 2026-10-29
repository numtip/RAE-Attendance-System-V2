-- Slice 2: provenance, computation status and idempotency for daily_attendance.
--
-- Why
--   * daily_attendance had no writer and no provenance: it could not say which rule version produced a row,
--     which normalized scans it came from, or whether the calculation was even possible. The blueprint
--     forbids a number without source, cutoff, filter, population and rule version (section 12).
--   * This adds the rule version, the provenance counters, the day classification and the reconciliation
--     payload, plus a link table holding the exact `attendance_events` rows that were aggregated.
--   * UNIQUE(employee_uid, date) makes recalculation idempotent: one row per employee-day, replaced in
--     place. Before this migration the schema had no such key, so a retry could duplicate a day.
--
-- Safety
--   * Additive and idempotent (information_schema-guarded); existing columns are untouched.
--   * PRECONDITION for the unique key: daily_attendance must not already contain two rows for the same
--     (employee_uid, date). The table has no writer in this repository, so it is empty in practice; if the
--     guarded ALTER fails, de-duplicate first (the failure is the intended signal, not a bug).
--   * daily_attendance_source_event is ON DELETE CASCADE from daily_attendance so a recalculation's
--     replacement cannot leave orphan links.
--   * Not applied to any host by this change.
--
-- Rollback: database/rollbacks/023_daily_attendance_provenance.down.sql

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'source_system'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN source_system VARCHAR(64) NULL DEFAULT NULL AFTER notes');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'rule_version_code'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN rule_version_code VARCHAR(64) NULL DEFAULT NULL AFTER source_system');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'schedule_code'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN schedule_code VARCHAR(64) NULL DEFAULT NULL AFTER rule_version_code');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;

-- 'pending_policy' is the honest outcome when no approved rule covers the date: no late/early/work numbers.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'computation_status'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN computation_status
     ENUM(''calculated'',''no_data'',''insufficient_data'',''pending_policy'',''failed'')
     NOT NULL DEFAULT ''calculated'' AFTER schedule_code');
PREPARE s4 FROM @ddl; EXECUTE s4; DEALLOCATE PREPARE s4;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'day_classification'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN day_classification
     ENUM(''workday'',''holiday'',''weekend'') NULL DEFAULT NULL AFTER computation_status');
PREPARE s5 FROM @ddl; EXECUTE s5; DEALLOCATE PREPARE s5;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'is_overnight'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN is_overnight TINYINT(1) NOT NULL DEFAULT 0 AFTER day_classification');
PREPARE s6 FROM @ddl; EXECUTE s6; DEALLOCATE PREPARE s6;

-- late_minutes already exists; the donor computed early minutes but never persisted them.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'early_minutes'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN early_minutes INT(11) NOT NULL DEFAULT 0 AFTER late_minutes');
PREPARE s7 FROM @ddl; EXECUTE s7; DEALLOCATE PREPARE s7;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'source_event_count'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN source_event_count INT(11) NOT NULL DEFAULT 0 AFTER is_overnight');
PREPARE s8 FROM @ddl; EXECUTE s8; DEALLOCATE PREPARE s8;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'first_event_at'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN first_event_at DATETIME NULL DEFAULT NULL AFTER source_event_count');
PREPARE s9 FROM @ddl; EXECUTE s9; DEALLOCATE PREPARE s9;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'last_event_at'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN last_event_at DATETIME NULL DEFAULT NULL AFTER first_event_at');
PREPARE s10 FROM @ddl; EXECUTE s10; DEALLOCATE PREPARE s10;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'calculated_at'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN calculated_at DATETIME NULL DEFAULT NULL AFTER last_event_at');
PREPARE s11 FROM @ddl; EXECUTE s11; DEALLOCATE PREPARE s11;

-- Reviewer-facing detail that does not deserve a column: ambiguity flags, candidate counts, tie-breaks.
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'reconciliation_json'
);
SET @ddl = IF(@col > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD COLUMN reconciliation_json JSON NULL DEFAULT NULL AFTER calculated_at');
PREPARE s12 FROM @ddl; EXECUTE s12; DEALLOCATE PREPARE s12;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance'
    AND INDEX_NAME = 'uk_daily_attendance_employee_date'
);
SET @ddl = IF(@idx > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD UNIQUE KEY uk_daily_attendance_employee_date (employee_uid, date)');
PREPARE s13 FROM @ddl; EXECUTE s13; DEALLOCATE PREPARE s13;

-- 'pending' is added to the pre-existing status ENUM so a day can be recorded HONESTLY when the facts are
-- known but no approved rule covers the date, or the scans cannot be interpreted. Without it the only
-- options would be 'present' or 'absent', both of which would assert something we cannot prove.
-- This is additive: existing readers that filter on the five original values are unaffected.
SET @status_type = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'status'
);
SET @ddl = IF(@status_type LIKE '%pending%', 'SELECT 1',
  'ALTER TABLE daily_attendance MODIFY COLUMN status
     ENUM(''present'',''late'',''absent'',''leave'',''holiday'',''pending'') NOT NULL');
PREPARE s15 FROM @ddl; EXECUTE s15; DEALLOCATE PREPARE s15;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance'
    AND INDEX_NAME = 'idx_daily_attendance_rule_version'
);
SET @ddl = IF(@idx > 0, 'SELECT 1',
  'ALTER TABLE daily_attendance ADD KEY idx_daily_attendance_rule_version (rule_version_code)');
PREPARE s14 FROM @ddl; EXECUTE s14; DEALLOCATE PREPARE s14;

-- Exact provenance: which normalized scans were aggregated into one employee-day.
CREATE TABLE IF NOT EXISTS daily_attendance_source_event (
  id BIGINT(20) NOT NULL AUTO_INCREMENT,
  daily_attendance_id INT(11) NOT NULL,
  attendance_event_id BIGINT(20) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_daily_attendance_source_event (daily_attendance_id, attendance_event_id),
  KEY idx_daily_attendance_source_event_event (attendance_event_id),
  CONSTRAINT fk_daily_attendance_source_event_daily
    FOREIGN KEY (daily_attendance_id) REFERENCES daily_attendance (id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_attendance_source_event_event
    FOREIGN KEY (attendance_event_id) REFERENCES attendance_events (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
