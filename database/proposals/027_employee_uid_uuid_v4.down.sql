-- Rollback for 027 (PROPOSAL) — drop the UUIDv4 shape constraint on employees.employee_uid.
--
-- This only removes a constraint. It does not restore any data, because the constraint never rewrote a row.
-- Safe to run twice: the information_schema guard makes the second run a no-op.

SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);

SET @ddl = IF(@has_check = 0, 'SELECT 1',
  'ALTER TABLE employees DROP CONSTRAINT chk_employees_employee_uid_uuid_v4');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SELECT @has_check AS constraint_present_after_rollback;
