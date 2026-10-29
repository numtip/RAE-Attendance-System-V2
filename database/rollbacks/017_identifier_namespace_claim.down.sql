-- Manual rollback for 017 (NOT auto-applied: lives outside database/migrations/). Take a backup first.
-- Drops the namespace triggers and the derived claim table (claims are fully derivable from employee_identifier).
-- employee_identifier rows are untouched. After rollback only the application-level check in
-- employeeIdentityService.linkIdentifier remains (not race-free).
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ai;
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_au;
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ad;
DROP TABLE IF EXISTS employee_identifier_namespace_claim;

-- Clearing the ledger row is part of the rollback (added 2026-10-29): the runner keys on the
-- filename, so without it `npm run db:migrate` believes this migration is still applied and the
-- schema stays partially rolled back.
DELETE FROM schema_migrations WHERE version = '017_identifier_namespace_claim.sql';
