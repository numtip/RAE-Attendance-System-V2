-- Local/operator rollback for 025. Drops the revocation table only.
-- Do not run against a database that must keep logout denials.

DROP TABLE IF EXISTS revoked_access_tokens;

-- Clearing the ledger row is part of the rollback (added 2026-10-29): the runner keys on the
-- filename, so without it `npm run db:migrate` believes this migration is still applied and the
-- schema stays partially rolled back.
DELETE FROM schema_migrations WHERE version = '025_revoked_access_tokens.sql';
