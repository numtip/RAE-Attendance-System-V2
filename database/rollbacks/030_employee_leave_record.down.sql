-- Rollback for 030_employee_leave_record. Drops HIP-recorded leave only; employee_leave, leave_balance
-- and every attendance table are untouched.
DROP TABLE IF EXISTS employee_leave_record_coverage;
DROP TABLE IF EXISTS employee_leave_record;
DELETE FROM schema_migrations WHERE version = '030_employee_leave_record.sql';
