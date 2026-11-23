-- Entitlement that HR has verified, per employee, fiscal year and leave type (sick / personal / vacation).
--
-- Keyed by fiscal_year_be: the Buddhist-era year in which the fiscal year (1 Oct - 30 Sep) ENDS, so FY2570 is
-- 2026-10-01 .. 2027-09-30. It is NOT leave_balance.year (a calendar year) and the two are never converted.
--
-- HR supplies the ENTITLEMENT, not the remaining balance: remaining is always computed as entitlement minus
-- approved leave, which is what prevents a day from being deducted twice.
--   entitlement_days  this year's right, excluding carry-over (vacation: 10, personal first year: 15, ...).
--   carryover_days    vacation only. NULL = not known, 0 = HR confirms nothing is carried over.
--   usage_baseline_*  days already used that are NOT in employee_leave_record (e.g. before the HIP import
--                     began) and the last date they cover. Records dated on or before that date are not
--                     deducted again. Both or neither.
--
-- import_batch_uid refers to leave_hr_import_batch (036); it is not a foreign key because 036 runs after this file.
-- Additive and idempotent; nothing is written by the migration.
-- Rollback: database/rollbacks/035_employee_leave_entitlement.down.sql

CREATE TABLE IF NOT EXISTS employee_leave_entitlement (
  id BIGINT NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  fiscal_year_be SMALLINT NOT NULL,
  leave_type ENUM('sick', 'personal', 'vacation') NOT NULL,
  entitlement_days DECIMAL(4,1) NOT NULL,
  carryover_days DECIMAL(4,1) NULL,
  usage_baseline_days DECIMAL(4,1) NULL,
  usage_baseline_through DATE NULL,
  source_reference VARCHAR(255) NOT NULL,
  import_batch_uid CHAR(36) NOT NULL,
  verified_by_uid VARCHAR(36) NOT NULL,
  verified_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_employee_leave_entitlement (employee_uid, fiscal_year_be, leave_type),
  KEY idx_employee_leave_entitlement_year (fiscal_year_be),
  KEY idx_employee_leave_entitlement_batch (import_batch_uid),
  CONSTRAINT fk_employee_leave_entitlement_employee FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_employee_leave_entitlement_verifier FOREIGN KEY (verified_by_uid) REFERENCES employees (employee_uid),
  CONSTRAINT chk_employee_leave_entitlement_year CHECK (fiscal_year_be BETWEEN 2569 AND 2700),
  CONSTRAINT chk_employee_leave_entitlement_days CHECK (
    entitlement_days >= 0 AND entitlement_days <= 120 AND entitlement_days * 2 = FLOOR(entitlement_days * 2)
  ),
  CONSTRAINT chk_employee_leave_entitlement_carryover CHECK (
    carryover_days IS NULL
    OR (leave_type = 'vacation' AND carryover_days >= 0 AND carryover_days <= 30 AND carryover_days * 2 = FLOOR(carryover_days * 2))
  ),
  CONSTRAINT chk_employee_leave_entitlement_baseline CHECK (
    (usage_baseline_days IS NULL) = (usage_baseline_through IS NULL)
    AND (usage_baseline_days IS NULL OR (usage_baseline_days >= 0 AND usage_baseline_days * 2 = FLOOR(usage_baseline_days * 2)))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
