CREATE TABLE monthly_summary (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  year INT(11) NOT NULL,
  month INT(11) NOT NULL,
  total_work_days INT(11) NOT NULL DEFAULT 0,
  total_present INT(11) NOT NULL DEFAULT 0,
  total_late INT(11) NOT NULL DEFAULT 0,
  total_absent INT(11) NOT NULL DEFAULT 0,
  total_leave INT(11) NOT NULL DEFAULT 0,
  total_late_minutes INT(11) NOT NULL DEFAULT 0,
  total_work_hours DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_monthly_summary_employee_uid (employee_uid),
  KEY idx_monthly_summary_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
