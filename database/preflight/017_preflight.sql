-- READ-ONLY preflight for 017_identifier_namespace_claim.sql. Run BEFORE migrating; collisions must be 0.
-- Counts only (no identifier values are selected).
SELECT
  (SELECT COUNT(*) FROM (
     SELECT id_value FROM employee_identifier
     WHERE id_type IN ('facescan_id', 'personnel_id')
     GROUP BY id_value HAVING COUNT(DISTINCT employee_uid) > 1) c)                       AS cross_employee_namespace_collisions,
  (SELECT COUNT(*) FROM (
     SELECT id_value FROM employee_identifier
     WHERE id_type IN ('facescan_id', 'personnel_id')
     GROUP BY id_value HAVING COUNT(DISTINCT id_type) > 1) c)                            AS values_in_both_namespaces_same_or_other_employee,
  (SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier')             AS employee_identifier_table_present,
  (SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
       AND COLUMN_NAME = 'id_value')                                                     AS id_value_collation,
  VERSION()                                                                              AS server_version;
-- cross_employee_namespace_collisions > 0 => STOP: human review of the colliding identities (never auto-merge).
-- id_value_collation should be utf8mb4_unicode_ci (the claim table uses the same collation so equality matches).
-- Also confirm the migration user has TRIGGER privilege and, if binary logging is on, that
-- log_bin_trust_function_creators=1 (or SUPER) is allowed by the operator.
