-- MJU SSO identity links (schema only). Runtime SSO remains disabled until contract confirmation.
CREATE TABLE identity_providers (
  id INT(11) NOT NULL AUTO_INCREMENT,
  provider_key VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_identity_providers_key (provider_key),
  KEY idx_identity_providers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employee_identity_links (
  id INT(11) NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(36) NOT NULL,
  provider_id INT(11) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  subject_type VARCHAR(64) NOT NULL DEFAULT 'opaque',
  email_snapshot VARCHAR(255) DEFAULT NULL,
  personnel_id_snapshot VARCHAR(64) DEFAULT NULL,
  citizen_id_hash VARCHAR(128) DEFAULT NULL,
  status ENUM('candidate', 'approved', 'rejected', 'revoked') NOT NULL DEFAULT 'candidate',
  confidence ENUM('high', 'medium', 'low', 'ambiguous', 'unknown') NOT NULL DEFAULT 'unknown',
  source VARCHAR(64) NOT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_employee_identity_provider_subject (provider_id, provider_subject),
  KEY idx_employee_identity_employee (employee_uid),
  KEY idx_employee_identity_status (status),
  KEY idx_employee_identity_lookup (provider_id, provider_subject, status),
  KEY idx_employee_identity_employee_provider (employee_uid, provider_id),
  CONSTRAINT fk_employee_identity_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_employee_identity_provider
    FOREIGN KEY (provider_id) REFERENCES identity_providers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO identity_providers (provider_key, name, status, created_at, updated_at)
VALUES ('mju_sso', 'MJU SSO', 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP());
