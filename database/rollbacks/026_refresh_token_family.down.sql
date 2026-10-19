-- Rolls back 026 on a disposable database.
-- Rows created after 026 have token NULL and cannot be turned back into the raw value.
-- Those sessions are deleted here and must sign in again. Rows that still hold a pre-026
-- plaintext token are kept.

DELETE FROM refresh_tokens WHERE token IS NULL;

DROP INDEX idx_refresh_tokens_family_id ON refresh_tokens;
DROP INDEX uk_refresh_tokens_token_hash ON refresh_tokens;

ALTER TABLE refresh_tokens
  DROP COLUMN parent_id,
  DROP COLUMN family_id,
  DROP COLUMN token_hash,
  MODIFY token VARCHAR(500) NOT NULL;
