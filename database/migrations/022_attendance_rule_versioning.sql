-- Slice 2: versioned attendance rules, the holiday calendar, and approved schedules.
--
-- Why
--   * The attendance rule values (work hours, late/early thresholds, leave tokens) lived only in the donor
--     project's settings.yaml and in Python defaults. Nothing in V2 was versioned, effective-dated or
--     approved, so a past period could not be recomputed reproducibly and no number had a rule version.
--   * attendance_rule_version carries the policy AS DATA with effective dates and an approval state.
--     An unapproved rule is never silently assumed: the calculation reports `pending_policy` instead of
--     inventing a result (see docs/ATTENDANCE_RULES.md).
--   * attendance_holiday owns the holiday calendar inside the engine. The donor relied on the caller to
--     pre-filter holiday rows, which meant a holiday row carrying clock times could still be flagged late.
--   * attendance_schedule is the optional per-employee assignment. Only an `approved` schedule may
--     influence a calculation; a pending one is reported, never assumed.
--
-- Non-goals: no write to daily_attendance, no data import, no change to existing tables.
--
-- Safety
--   * Additive and idempotent (information_schema-guarded), no existing table altered, no row rewritten.
--   * rule_version_code is an immutable natural key: it is referenced by daily_attendance provenance, so a
--     code must never be renamed or reused. Supersede a version by inserting a new one and setting the old
--     row to `retired`.
--   * Not applied to any host by this change.
--
-- Rollback: database/rollbacks/022_attendance_rule_versioning.down.sql

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
  'SELECT * FROM ABORT_022_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- 1. Versioned rule set ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS attendance_rule_version (
  rule_version_code VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- 'approved' is the ONLY state the engine will compute with. Everything else is reported, never assumed.
  status ENUM('draft', 'pending_approval', 'approved', 'retired') NOT NULL DEFAULT 'draft',
  effective_from DATE NOT NULL,
  effective_to DATE DEFAULT NULL,
  work_start TIME NOT NULL,
  work_end TIME NOT NULL,
  -- Inclusive lateness threshold and earliest acceptable departure. Default to work_start/work_end.
  late_after TIME NOT NULL,
  early_before TIME NOT NULL,
  -- Donor gap: the donor compared bare clock values on one date, so a post-midnight checkout was always
  -- "early". When 1, a checkout earlier than the check-in is treated as the next day.
  overnight_shift TINYINT(1) NOT NULL DEFAULT 0,
  -- Guard rail against a nonsense span (for example a same-day typo that looks like 20 hours).
  max_shift_span_minutes INT(11) NOT NULL DEFAULT 960,
  ignore_holidays TINYINT(1) NOT NULL DEFAULT 1,
  -- The working week, owned by the approved rule so the engine never silently assumes Mon-Fri.
  -- JSON array of ISO-8601 day numbers (1=Monday .. 7=Sunday). NULL means "not specified" and the engine
  -- records that it defaulted, rather than pretending the week was approved.
  work_days_json JSON DEFAULT NULL,
  -- Policy token lists, versioned with the rule instead of hard-coded. JSON so a new token needs no DDL.
  leave_types_json JSON DEFAULT NULL,
  leave_aliases_json JSON DEFAULT NULL,
  business_statuses_json JSON DEFAULT NULL,
  -- Where the values came from and who approved them. An approved row must name a human approver.
  source_of_truth VARCHAR(500) DEFAULT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (rule_version_code),
  KEY idx_rule_version_effective (effective_from, effective_to, status),
  KEY idx_rule_version_status (status),
  CONSTRAINT chk_rule_version_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- An approved rule must be traceable: no approval without an approver and a timestamp.
  CONSTRAINT chk_rule_version_approval CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Holiday calendar owned by the engine --------------------------------------

CREATE TABLE IF NOT EXISTS attendance_holiday (
  id INT(11) NOT NULL AUTO_INCREMENT,
  holiday_date DATE NOT NULL,
  name VARCHAR(255) NOT NULL,
  scope ENUM('national', 'university', 'department') NOT NULL DEFAULT 'university',
  org_unit_code VARCHAR(64) DEFAULT NULL,
  -- Only 'approved' holidays exclude attendance. A candidate is a proposal, not a rule.
  status ENUM('candidate', 'approved') NOT NULL DEFAULT 'candidate',
  source_system VARCHAR(64) NOT NULL,
  source_reference VARCHAR(255) DEFAULT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  -- MySQL treats NULLs as distinct in a UNIQUE key, so a national holiday (org_unit_code NULL) could be
  -- inserted twice. The generated column gives every scope a concrete key while staying NULL-free.
  scope_key VARCHAR(64) GENERATED ALWAYS AS (COALESCE(org_unit_code, '')) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_attendance_holiday_date_scope (holiday_date, scope, scope_key),
  KEY idx_attendance_holiday_date (holiday_date),
  KEY idx_attendance_holiday_status (status),
  CONSTRAINT chk_attendance_holiday_approval CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Optional per-employee schedule --------------------------------------------

CREATE TABLE IF NOT EXISTS attendance_schedule (
  schedule_code VARCHAR(64) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- Only 'approved' is usable by the engine.
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  effective_from DATE NOT NULL,
  effective_to DATE DEFAULT NULL,
  work_start TIME NOT NULL,
  work_end TIME NOT NULL,
  late_after TIME NOT NULL,
  early_before TIME NOT NULL,
  -- 1=Sunday .. 7=Saturday, ISO-8601. JSON array of the days this schedule is a work day.
  work_days_json JSON NOT NULL,
  overnight_shift TINYINT(1) NOT NULL DEFAULT 0,
  source_system VARCHAR(64) NOT NULL,
  source_reference VARCHAR(255) DEFAULT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (schedule_code),
  UNIQUE KEY uk_attendance_schedule_employee_from (employee_uid, effective_from),
  KEY idx_attendance_schedule_employee (employee_uid),
  KEY idx_attendance_schedule_status (status),
  CONSTRAINT fk_attendance_schedule_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT chk_attendance_schedule_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_attendance_schedule_approval CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
