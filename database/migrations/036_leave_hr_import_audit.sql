-- Audit trail for the HR leave-data import: one row per applied file (batch) and one row per changed field.
--
-- leave_hr_import_batch.file_sha256 is unique per kind, which is what makes re-importing the same file a
-- no-op. Only APPLIED batches are stored; a dry run writes nothing anywhere.
-- leave_hr_audit keeps the before / after value of each field (<= 200 characters, same shape as
-- employee_leave_record_audit). It records values the HR file itself carried (dates, day counts, document
-- references); it never stores names or free text from the personnel file.
--
-- Additive and idempotent; nothing is written by the migration.
-- Rollback: database/rollbacks/036_leave_hr_import_audit.down.sql

CREATE TABLE IF NOT EXISTS leave_hr_import_batch (
  batch_uid CHAR(36) NOT NULL,
  kind ENUM('profile', 'entitlement') NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  rows_read INT NOT NULL,
  rows_applied INT NOT NULL,
  rows_unchanged INT NOT NULL,
  operator_uid VARCHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (batch_uid),
  UNIQUE KEY uk_leave_hr_import_batch_file (kind, file_sha256),
  CONSTRAINT fk_leave_hr_import_batch_operator FOREIGN KEY (operator_uid) REFERENCES employees (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_hr_audit (
  id BIGINT NOT NULL AUTO_INCREMENT,
  batch_uid CHAR(36) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  table_name ENUM('employees', 'employee_leave_profile', 'employee_leave_entitlement') NOT NULL,
  field_name VARCHAR(40) NOT NULL,
  entity_key VARCHAR(40) NULL,
  before_value VARCHAR(200) NULL,
  after_value VARCHAR(200) NULL,
  actor_uid VARCHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_leave_hr_audit_batch (batch_uid),
  KEY idx_leave_hr_audit_employee (employee_uid),
  CONSTRAINT fk_leave_hr_audit_batch FOREIGN KEY (batch_uid) REFERENCES leave_hr_import_batch (batch_uid),
  CONSTRAINT fk_leave_hr_audit_employee FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_leave_hr_audit_actor FOREIGN KEY (actor_uid) REFERENCES employees (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
