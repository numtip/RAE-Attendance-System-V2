-- HIP-recorded leave (derived from the `Remark [n]` column of the monthly HIP daily reports).
--
-- This is deliberately NOT employee_leave. employee_leave is the officially approved leave source and
-- balances; this table holds what the HIP report says. A row here is a candidate classification,
-- never proof of HR approval: approval_status stays 'unverified' until a real approval source exists,
-- and nothing here deducts an entitlement or touches leave_balance.
--
-- Precision: 1.0 day (FULL) or 0.5 day (AM / PM). A row the rules cannot classify safely is stored as
-- review_status = 'needs_review' with day_part UNKNOWN and no fraction, so it is visible but is never
-- summed into a total.
--
-- Free-text remarks are NOT stored (they can carry health detail); only the normalised leave type.
-- Idempotent import key: (employee_uid, leave_date, day_part, source_system).
-- Rollback: database/rollbacks/030_employee_leave_record.down.sql

CREATE TABLE IF NOT EXISTS employee_leave_record (
  record_uid CHAR(36) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  leave_date DATE NOT NULL,
  leave_type ENUM('personal', 'sick', 'vacation') NOT NULL,
  day_part ENUM('FULL', 'AM', 'PM', 'UNKNOWN') NOT NULL,
  day_fraction DECIMAL(2,1) NULL,
  review_status ENUM('candidate', 'needs_review') NOT NULL,
  review_reason VARCHAR(120) NULL,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
  source_system VARCHAR(64) NOT NULL,
  source_period CHAR(7) NOT NULL,
  source_line INT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (record_uid),
  UNIQUE KEY uk_employee_leave_record (employee_uid, leave_date, day_part, source_system),
  KEY idx_employee_leave_record_date (leave_date),
  KEY idx_employee_leave_record_review (review_status),
  CONSTRAINT fk_employee_leave_record_employee FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT chk_employee_leave_record_fraction CHECK (
    (review_status = 'candidate' AND day_part = 'FULL' AND day_fraction = 1.0)
    OR (review_status = 'candidate' AND day_part IN ('AM', 'PM') AND day_fraction = 0.5)
    OR (review_status = 'needs_review' AND day_fraction IS NULL)
  ),
  CONSTRAINT chk_employee_leave_record_approval CHECK (approval_status IN ('unverified', 'approved', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which months a source actually covered. Without it "no leave in March" cannot be told apart from
-- "March was never imported".
CREATE TABLE IF NOT EXISTS employee_leave_record_coverage (
  source_system VARCHAR(64) NOT NULL,
  source_period CHAR(7) NOT NULL,
  rows_scanned INT NOT NULL,
  employees_in_source INT NOT NULL,
  imported_at DATETIME NOT NULL,
  PRIMARY KEY (source_system, source_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
