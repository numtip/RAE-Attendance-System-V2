-- Rollback for 031_leave_record_review. Drops the audit trail and the reviewer columns; the leave
-- records themselves (and any approval_status already set) stay.
DROP TABLE IF EXISTS employee_leave_record_audit;
ALTER TABLE employee_leave_record
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by_uid;
DELETE FROM schema_migrations WHERE version = '031_leave_record_review.sql';
