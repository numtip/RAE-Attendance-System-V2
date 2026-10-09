-- Phase B: normalized attendance events from resolved FaceScan raw rows. No daily_attendance.

CREATE TABLE attendance_events (
  id BIGINT(20) NOT NULL AUTO_INCREMENT,
  event_uid VARCHAR(36) NOT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  staging_facescan_raw_id BIGINT(20) NOT NULL,
  import_batch_uid VARCHAR(36) NOT NULL,
  source_system VARCHAR(64) NOT NULL,
  source_event_key CHAR(64) NOT NULL,
  source_type VARCHAR(64) NOT NULL DEFAULT 'facescan_checkinout',
  facescan_id VARCHAR(64) NOT NULL,
  event_time DATETIME NOT NULL,
  check_type VARCHAR(16) DEFAULT NULL,
  verify_code VARCHAR(32) DEFAULT NULL,
  sensor_id VARCHAR(64) DEFAULT NULL,
  work_code VARCHAR(32) DEFAULT NULL,
  timezone_label VARCHAR(32) NOT NULL DEFAULT 'Asia/Bangkok',
  normalized_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_attendance_events_event_uid (event_uid),
  UNIQUE KEY uk_attendance_events_staging_raw (staging_facescan_raw_id),
  UNIQUE KEY uk_attendance_events_source_event (source_system, source_event_key),
  KEY idx_attendance_events_employee_time (employee_uid, event_time),
  KEY idx_attendance_events_batch (import_batch_uid),
  KEY idx_attendance_events_facescan (facescan_id),
  CONSTRAINT fk_attendance_events_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_attendance_events_staging_raw
    FOREIGN KEY (staging_facescan_raw_id) REFERENCES staging_facescan_raw (id),
  CONSTRAINT fk_attendance_events_import_batch
    FOREIGN KEY (import_batch_uid) REFERENCES facescan_import_batches (batch_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
