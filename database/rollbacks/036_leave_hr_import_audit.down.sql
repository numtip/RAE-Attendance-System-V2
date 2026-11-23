-- Rollback for 036_leave_hr_import_audit. Drops the import batch ledger and its field audit (children first).
-- Export both tables first if an HR import was applied: the audit cannot be rebuilt.
DROP TABLE IF EXISTS leave_hr_audit;
DROP TABLE IF EXISTS leave_hr_import_batch;
DELETE FROM schema_migrations WHERE version = '036_leave_hr_import_audit.sql';
