CREATE TABLE leave_balance (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  year INT(11) NOT NULL,
  leave_type ENUM('sick', 'personal', 'vacation', 'maternity', 'paternity', 'study') NOT NULL,
  total_days DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  used_days DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  remaining_days DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_leave_balance_employee_uid (employee_uid),
  KEY idx_leave_balance_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
