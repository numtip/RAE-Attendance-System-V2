-- Rollback for 034_employee_leave_profile. Drops HR-confirmed leave facts only; employees (including
-- hire_date) and every leave table are untouched. Export the table first if HR data was imported.
DROP TABLE IF EXISTS employee_leave_profile;
DELETE FROM schema_migrations WHERE version = '034_employee_leave_profile.sql';
