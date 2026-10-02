-- Phase A: FaceScan raw ingestion (staging + batch + idempotency). No normalized daily_attendance yet.

CREATE TABLE facescan_import_batches (
  id VARCHAR(36) NOT NULL,
  source_system VARCHAR(64) NOT NULL DEFAULT 'facescan_db',
  source_label VARCHAR(255) DEFAULT NULL,
  status ENUM('open', 'committed', 'failed') NOT NULL DEFAULT 'open',
  row_count INT(11) NOT NULL DEFAULT 0,
  inserted_count INT(11) NOT NULL DEFAULT 0,
  duplicate_count INT(11) NOT NULL DEFAULT 0,
  unmapped_count INT(11) NOT NULL DEFAULT 0,
  resolved_count INT(11) NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  finished_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_facescan_import_batches_status (status),
  KEY idx_facescan_import_batches_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staging_facescan_raw (
  id BIGINT(20) NOT NULL AUTO_INCREMENT,
  batch_id VARCHAR(36) NOT NULL,
  facescan_id VARCHAR(64) NOT NULL,
  scan_datetime DATETIME NOT NULL,
  scan_type ENUM('in', 'out', 'unknown') NOT NULL DEFAULT 'unknown',
  payload_json JSON DEFAULT NULL,
  idempotency_key CHAR(64) NOT NULL,
  employee_uid VARCHAR(36) DEFAULT NULL,
  resolution_status ENUM('resolved', 'unmapped', 'duplicate') NOT NULL,
  resolved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_staging_facescan_raw_idempotency (idempotency_key),
  KEY idx_staging_facescan_raw_batch (batch_id),
  KEY idx_staging_facescan_raw_facescan (facescan_id),
  KEY idx_staging_facescan_raw_scan_time (scan_datetime),
  KEY idx_staging_facescan_raw_resolution (resolution_status, facescan_id),
  KEY idx_staging_facescan_raw_employee (employee_uid),
  CONSTRAINT fk_staging_facescan_raw_batch
    FOREIGN KEY (batch_id) REFERENCES facescan_import_batches (id),
  CONSTRAINT fk_staging_facescan_raw_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
