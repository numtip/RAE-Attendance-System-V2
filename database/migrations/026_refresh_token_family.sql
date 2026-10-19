-- Refresh-token families and hashed storage.
--
-- 018_ and 019_ stay reserved for draft PR #35. 025_revoked_access_tokens.sql stays as it is.
-- Existing rows keep their plaintext token and a NULL token_hash, so a session issued before
-- this migration still validates. New rows store only the SHA-256 hash and a family id.
-- Not applied to any host by this change.
-- Rollback: database/rollbacks/026_refresh_token_family.down.sql

ALTER TABLE refresh_tokens
  MODIFY token VARCHAR(500) NULL,
  ADD COLUMN token_hash CHAR(64) NULL AFTER token,
  ADD COLUMN family_id CHAR(36) NULL AFTER token_hash,
  ADD COLUMN parent_id INT(11) NULL AFTER family_id;

CREATE UNIQUE INDEX uk_refresh_tokens_token_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_refresh_tokens_family_id ON refresh_tokens (family_id);
