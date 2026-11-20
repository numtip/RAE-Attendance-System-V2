-- Rollback for 033. Drops the title column; first/last names are untouched.
ALTER TABLE employees DROP COLUMN IF EXISTS title_th;
DELETE FROM schema_migrations WHERE version = '033_employee_title.sql';
