-- Release 1 leave rows (matches backend/src/dev/fixtures.js shape; not staging_leave).
CREATE TABLE employee_leave (
  leave_id VARCHAR(100) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  leave_type ENUM('sick', 'personal', 'vacation', 'other') NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  match_status ENUM('matched', 'unmatched', 'pending') NOT NULL DEFAULT 'matched',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (leave_id),
  KEY idx_employee_leave_employee_uid (employee_uid),
  KEY idx_employee_leave_start_date (start_date),
  KEY idx_employee_leave_match_status (match_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
