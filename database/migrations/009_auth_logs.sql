CREATE TABLE auth_logs (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) DEFAULT NULL,
  email VARCHAR(100) DEFAULT NULL,
  event_type ENUM('login', 'logout', 'refresh', 'failed_login', 'locked') NOT NULL,
  success TINYINT(1) NOT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_auth_logs_employee_uid (employee_uid),
  KEY idx_auth_logs_event_type (event_type),
  KEY idx_auth_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
