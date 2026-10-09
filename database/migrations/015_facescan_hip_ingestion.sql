-- HIP Pm2014 FaceScan model (replaces 014 skeleton). Safe when 014 tables are empty (pre-production).
-- Drops 014 staging tables and recreates batch + raw + USERINFO staging. No daily_attendance.

DROP TABLE IF EXISTS staging_facescan_raw;
DROP TABLE IF EXISTS facescan_import_batches;

CREATE TABLE facescan_import_batches (
  batch_uid VARCHAR(36) NOT NULL,
  source_system VARCHAR(64) NOT NULL DEFAULT 'hip_pm2014',
  source_type VARCHAR(64) NOT NULL DEFAULT 'checkinout',
  source_reference VARCHAR(255) DEFAULT NULL,
  window_from DATETIME DEFAULT NULL,
  window_to DATETIME DEFAULT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME DEFAULT NULL,
  rows_read INT(11) NOT NULL DEFAULT 0,
  rows_inserted INT(11) NOT NULL DEFAULT 0,
  rows_duplicate INT(11) NOT NULL DEFAULT 0,
  rows_unmapped INT(11) NOT NULL DEFAULT 0,
  rows_failed INT(11) NOT NULL DEFAULT 0,
  status ENUM('open', 'completed', 'failed') NOT NULL DEFAULT 'open',
  error_summary TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (batch_uid),
  KEY idx_facescan_import_batches_status (status),
  KEY idx_facescan_import_batches_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staging_facescan_raw (
  id BIGINT(20) NOT NULL AUTO_INCREMENT,
  source_system VARCHAR(64) NOT NULL,
  source_event_key CHAR(64) NOT NULL,
  facescan_id VARCHAR(64) NOT NULL,
  check_time DATETIME NOT NULL,
  check_type VARCHAR(16) DEFAULT NULL,
  verify_code VARCHAR(32) DEFAULT NULL,
  sensor_id VARCHAR(64) DEFAULT NULL,
  work_code VARCHAR(32) DEFAULT NULL,
  employee_uid VARCHAR(36) DEFAULT NULL,
  resolution_status ENUM('resolved', 'unmapped') NOT NULL,
  import_batch_uid VARCHAR(36) NOT NULL,
  raw_payload JSON DEFAULT NULL,
  imported_at DATETIME NOT NULL,
  resolved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_staging_facescan_raw_source_event (source_event_key),
  KEY idx_staging_facescan_raw_batch (import_batch_uid),
  KEY idx_staging_facescan_raw_facescan (facescan_id),
  KEY idx_staging_facescan_raw_check_time (check_time),
  KEY idx_staging_facescan_raw_resolution (resolution_status, facescan_id),
  KEY idx_staging_facescan_raw_employee (employee_uid),
  CONSTRAINT fk_staging_facescan_raw_batch
    FOREIGN KEY (import_batch_uid) REFERENCES facescan_import_batches (batch_uid),
  CONSTRAINT fk_staging_facescan_raw_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staging_facescan_users (
  id BIGINT(20) NOT NULL AUTO_INCREMENT,
  facescan_id VARCHAR(64) NOT NULL,
  badge_number VARCHAR(64) DEFAULT NULL,
  display_name VARCHAR(255) DEFAULT NULL,
  card_metadata VARCHAR(255) DEFAULT NULL,
  privilege VARCHAR(64) DEFAULT NULL,
  group_name VARCHAR(128) DEFAULT NULL,
  source_system VARCHAR(64) NOT NULL,
  imported_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_staging_facescan_users_source_facescan (source_system, facescan_id),
  KEY idx_staging_facescan_users_facescan (facescan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
