-- Rollback for 032. Refuses (the ALTER fails) while any row still uses the new value; move those rows
-- to another type first.
ALTER TABLE employees
  MODIFY COLUMN employee_type ENUM('university', 'department', 'contract') NOT NULL;
DELETE FROM schema_migrations WHERE version = '032_employee_type_procurement_academic.sql';
