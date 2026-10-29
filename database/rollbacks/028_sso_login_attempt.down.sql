-- Rollback for 028_sso_login_attempt.
-- Only safe while SSO is off, or after every pending login has expired.
DROP TABLE IF EXISTS sso_login_attempt;

-- Clearing the ledger row is part of the rollback (added 2026-10-29): the runner keys on the
-- filename, so without it `npm run db:migrate` believes this migration is still applied and the
-- schema stays partially rolled back.
DELETE FROM schema_migrations WHERE version = '028_sso_login_attempt.sql';
