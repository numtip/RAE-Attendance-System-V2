-- Rollback for 035_employee_leave_entitlement. Drops the HR-verified entitlements only; leave_balance and
-- every leave record are untouched. Export the table first if HR data was imported.
DROP TABLE IF EXISTS employee_leave_entitlement;
DELETE FROM schema_migrations WHERE version = '035_employee_leave_entitlement.sql';
