-- Manual rollback for 017 (NOT auto-applied: lives outside database/migrations/). Take a backup first.
-- Drops the namespace triggers and the derived claim table (claims are fully derivable from employee_identifier).
-- employee_identifier rows are untouched. After rollback only the application-level check in
-- employeeIdentityService.linkIdentifier remains (not race-free).
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ai;
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_au;
DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ad;
DROP TABLE IF EXISTS employee_identifier_namespace_claim;
