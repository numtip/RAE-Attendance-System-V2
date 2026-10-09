-- Identity foundation: FK, global uniqueness, aligned id_type enum, metadata columns.
-- Fails safely if duplicate (id_type,id_value) or orphan employee_uid exist.
-- Do not auto-delete or rewrite conflicting rows.

ALTER TABLE employee_identifier
  ADD COLUMN source_system VARCHAR(64) NULL DEFAULT NULL AFTER id_value,
  ADD COLUMN status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER is_primary,
  ADD COLUMN verified_at DATETIME NULL DEFAULT NULL AFTER status;

ALTER TABLE employee_identifier
  MODIFY COLUMN id_type ENUM('employee_id', 'personnel_id', 'facescan_id', 'national_id') NOT NULL;

ALTER TABLE employee_identifier
  ADD UNIQUE KEY uk_employee_identifier_type_value (id_type, id_value),
  ADD KEY idx_employee_identifier_employee_type (employee_uid, id_type),
  ADD CONSTRAINT fk_employee_identifier_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid);
