CREATE TABLE employee_identifier (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  id_type ENUM('facescan_id', 'national_id', 'employee_id') NOT NULL,
  id_value VARCHAR(255) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_employee_identifier_employee_uid (employee_uid),
  KEY idx_employee_identifier_id_type (id_type),
  KEY idx_employee_identifier_id_value (id_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
