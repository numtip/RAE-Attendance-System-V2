-- Opaque scope labels only. This migration does not name departments or a hierarchy.
CREATE TABLE employee_org_membership (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  org_unit_code VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_employee_org_membership (employee_uid, org_unit_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE authorization_grants (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  role ENUM('EXECUTIVE', 'MANAGER', 'EMPLOYEE', 'ADMIN') NOT NULL,
  scope_type ENUM('self', 'org_unit', 'organization') NOT NULL,
  org_unit_code VARCHAR(100) DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_authorization_grants_employee_uid (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
