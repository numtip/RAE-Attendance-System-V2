-- Binding and login-handoff claims for more than one API process.
-- Not the portal `ac` table (018_sso_consumed_code). Do not merge those rows.
-- Stores a SHA-256 digest plus a server-side JSON payload. The raw code is not written.
-- Forward only. Missing table must fail closed (503), never fall back to process memory.
-- Not applied to production by this change. Stock migrate is not run here.

CREATE TABLE IF NOT EXISTS sso_shared_claim (
  claim_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('binding', 'handoff') NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (claim_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
