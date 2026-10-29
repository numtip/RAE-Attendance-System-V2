-- Rollback for 023_daily_attendance_provenance.sql.
-- Removes the provenance columns, the two indexes and the source-event link table.
-- WARNING: this discards the rule version, computation status and source-event provenance of every
-- existing daily_attendance row, and the rollback cannot restore it. Export first:
--   SELECT * FROM daily_attendance;  SELECT * FROM daily_attendance_source_event;
-- The link table is dropped first so its FK to daily_attendance disappears before the columns do.
-- Idempotent: safe to run when part of the migration was already reversed.

-- WARNING: this does NOT narrow the `status` ENUM back to its original five values. A row whose status is
-- 'pending' would be rejected (or silently truncated) by a narrowed ENUM in strict mode, so the widening is
-- deliberately left in place: it is additive and harmless to keep. Narrow it only after every 'pending' row
-- has been dealt with:
--   SELECT COUNT(*) FROM daily_attendance WHERE status = 'pending';
--   ALTER TABLE daily_attendance MODIFY COLUMN status
--     ENUM('present','late','absent','leave','holiday') NOT NULL;
-- Idempotent: safe to run when part of the migration was already reversed.

DROP TABLE IF EXISTS daily_attendance_source_event;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance'
    AND INDEX_NAME = 'idx_daily_attendance_rule_version'
);
SET @ddl = IF(@idx = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP KEY idx_daily_attendance_rule_version');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

SET @idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance'
    AND INDEX_NAME = 'uk_daily_attendance_employee_date'
);
SET @ddl = IF(@idx = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP KEY uk_daily_attendance_employee_date');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'reconciliation_json'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN reconciliation_json');
PREPARE r2 FROM @ddl; EXECUTE r2; DEALLOCATE PREPARE r2;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'calculated_at'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN calculated_at');
PREPARE r3 FROM @ddl; EXECUTE r3; DEALLOCATE PREPARE r3;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'last_event_at'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN last_event_at');
PREPARE r4 FROM @ddl; EXECUTE r4; DEALLOCATE PREPARE r4;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'first_event_at'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN first_event_at');
PREPARE r5 FROM @ddl; EXECUTE r5; DEALLOCATE PREPARE r5;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'source_event_count'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN source_event_count');
PREPARE r6 FROM @ddl; EXECUTE r6; DEALLOCATE PREPARE r6;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'early_minutes'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN early_minutes');
PREPARE r7 FROM @ddl; EXECUTE r7; DEALLOCATE PREPARE r7;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'is_overnight'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN is_overnight');
PREPARE r8 FROM @ddl; EXECUTE r8; DEALLOCATE PREPARE r8;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'day_classification'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN day_classification');
PREPARE r9 FROM @ddl; EXECUTE r9; DEALLOCATE PREPARE r9;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'computation_status'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN computation_status');
PREPARE r10 FROM @ddl; EXECUTE r10; DEALLOCATE PREPARE r10;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'schedule_code'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN schedule_code');
PREPARE r11 FROM @ddl; EXECUTE r11; DEALLOCATE PREPARE r11;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'rule_version_code'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN rule_version_code');
PREPARE r12 FROM @ddl; EXECUTE r12; DEALLOCATE PREPARE r12;

SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'source_system'
);
SET @ddl = IF(@col = 0, 'SELECT 1',
  'ALTER TABLE daily_attendance DROP COLUMN source_system');
PREPARE r13 FROM @ddl; EXECUTE r13; DEALLOCATE PREPARE r13;

-- Clearing the ledger row is part of the rollback (added 2026-10-29): the runner keys on the
-- filename, so without it `npm run db:migrate` believes this migration is still applied and the
-- schema stays partially rolled back.
DELETE FROM schema_migrations WHERE version = '023_daily_attendance_provenance.sql';
