-- Optional minimal diagnostics table (not on Release 1 read path).
CREATE TABLE system_logs (
  id INT(11) NOT NULL AUTO_INCREMENT,
  source VARCHAR(50) NOT NULL,
  level ENUM('info', 'warning', 'error', 'critical') NOT NULL,
  code VARCHAR(10) DEFAULT NULL,
  message TEXT NOT NULL,
  details LONGTEXT DEFAULT NULL,
  ref_id VARCHAR(100) DEFAULT NULL,
  user_id VARCHAR(50) DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_system_logs_source (source),
  KEY idx_system_logs_level (level),
  KEY idx_system_logs_code (code),
  KEY idx_system_logs_ref_id (ref_id),
  KEY idx_system_logs_user_id (user_id),
  KEY idx_system_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
