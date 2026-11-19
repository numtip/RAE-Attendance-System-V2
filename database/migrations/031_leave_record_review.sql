-- Review / approval of HIP-recorded leave by an executive with an organization grant.
--
-- A decision is a human act on a record, never an inference: it sets approval_status
-- (unverified | approved | rejected), who decided and when, and appends one audit row. It does not
-- touch employee_leave, leave_balance or any attendance table, and it deducts no entitlement.
-- Re-running is safe (IF NOT EXISTS). Rollback: database/rollbacks/031_leave_record_review.down.sql

ALTER TABLE employee_leave_record
  ADD COLUMN IF NOT EXISTS reviewed_by_uid VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(200) NULL;

CREATE TABLE IF NOT EXISTS employee_leave_record_audit (
  id BIGINT NOT NULL AUTO_INCREMENT,
  record_uid CHAR(36) NOT NULL,
  actor_uid VARCHAR(36) NOT NULL,
  action VARCHAR(20) NOT NULL,
  before_state VARCHAR(200) NOT NULL,
  after_state VARCHAR(200) NOT NULL,
  note VARCHAR(200) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_leave_record_audit_record (record_uid),
  KEY idx_leave_record_audit_actor (actor_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
