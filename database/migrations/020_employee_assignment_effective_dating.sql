-- Slice 1: effective-dated employee master + effective-dated identity mapping.
--
-- Why
--   * employee_assignment: the immutable employee UUID and the login record stay in `employees`; the
--     mutable employment attributes (employee code, department, position, employee_type) gain an
--     effective-dated history, so a report for a past period can be recomputed with the data that was
--     true then instead of the current row. Blueprint section 8: "separate assignment/emp_code history;
--     preserve effective dates and ownership conflict evidence".
--   * employee_identifier.effective_from / effective_to: the (id_type, id_value) -> employee_uid mapping
--     gains a validity window, so an attendance event is resolved only through a mapping that was
--     effective on the event date. NULL effective_to means "still open".
--   * employee_identifier_access_audit: the existing append-only log gets an 'effective_change' action
--     plus the two window columns, so every validity change is auditable with actor and reason.
--
-- Non-goals: no attendance rule math, no daily_attendance writer, no attendance provenance columns
-- (those depend on a versioned rule contract and stay in the next slice).
--
-- Safety
--   * Additive and idempotent: every step is guarded by information_schema, so a partial failure (DDL
--     auto-commits and the runner's ledger keys on the filename) is repaired by re-running this file.
--   * The security-critical unique keys are NOT touched: uk_employee_identifier_type_value,
--     uk_employee_identifier_national_owner, chk_employee_identifier_national_lookup and the
--     migration-017 namespace triggers all keep their exact behaviour.
--   * No row is deleted, rewritten or backfilled. Existing identifier rows keep NULL windows, which
--     read as "unbounded" and therefore resolve exactly as before this migration.
--   * Requires MariaDB >= 10.2.3 for enforced CHECK constraints, the same floor as migration 015.
--   * Not applied to any host by this change.
--
-- Rollback: database/rollbacks/020_employee_assignment_effective_dating.down.sql

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
  'SELECT * FROM ABORT_020_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- 1. Effective-dated employment attributes -------------------------------------

CREATE TABLE IF NOT EXISTS employee_assignment (
  assignment_uid VARCHAR(36) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  employee_code VARCHAR(50) NOT NULL,
  department VARCHAR(100) NOT NULL,
  position VARCHAR(100) DEFAULT NULL,
  employee_type ENUM('university', 'department', 'contract') NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE DEFAULT NULL,
  source_system VARCHAR(64) NOT NULL,
  source_reference VARCHAR(255) DEFAULT NULL,
  recorded_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (assignment_uid),
  UNIQUE KEY uk_employee_assignment_employee_from (employee_uid, effective_from),
  KEY idx_employee_assignment_employee (employee_uid),
  KEY idx_employee_assignment_code (employee_code),
  KEY idx_employee_assignment_department (department),
  KEY idx_employee_assignment_effective (employee_uid, effective_to),
  CONSTRAINT fk_employee_assignment_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT chk_employee_assignment_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Effective validity window on the identity mapping -------------------------

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'effective_from'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD COLUMN effective_from DATE NULL DEFAULT NULL AFTER verified_at');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier' AND COLUMN_NAME = 'effective_to'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD COLUMN effective_to DATE NULL DEFAULT NULL AFTER effective_from');
PREPARE s2 FROM @ddl; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
    AND INDEX_NAME = 'idx_employee_identifier_effective'
);
SET @ddl = IF(@idx_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier ADD KEY idx_employee_identifier_effective (id_type, id_value, effective_to)');
PREPARE s3 FROM @ddl; EXECUTE s3; DEALLOCATE PREPARE s3;

-- 3. Auditability of validity changes ------------------------------------------

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_access_audit'
    AND COLUMN_NAME = 'effective_from'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identifier_access_audit
     ADD COLUMN effective_from DATE NULL DEFAULT NULL AFTER key_version,
     ADD COLUMN effective_to DATE NULL DEFAULT NULL AFTER effective_from');
PREPARE s4 FROM @ddl; EXECUTE s4; DEALLOCATE PREPARE s4;

SET @action_type = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier_access_audit'
    AND COLUMN_NAME = 'action'
);
SET @ddl = IF(@action_type LIKE '%effective_change%', 'SELECT 1',
  'ALTER TABLE employee_identifier_access_audit
     MODIFY COLUMN action
     ENUM(''lookup'',''create'',''decrypt'',''reindex'',''delete'',''key_rotation'',''effective_change'')
     NOT NULL');
PREPARE s5 FROM @ddl; EXECUTE s5; DEALLOCATE PREPARE s5;
