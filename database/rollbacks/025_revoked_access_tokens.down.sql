-- Local/operator rollback for 025. Drops the revocation table only.
-- Do not run against a database that must keep logout denials.

DROP TABLE IF EXISTS revoked_access_tokens;
