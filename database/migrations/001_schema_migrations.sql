-- Track applied migration versions (runner also bootstraps this table if missing).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
