-- READ-ONLY preflight for 015_employee_identifier_secure_lookup.sql. Run BEFORE migrating; every value must be 0
-- (except rows in the audit/secret tables, which do not exist yet). Counts only: never SELECT id_value.
-- Runs on the post-013 schema (does not reference columns that 015 adds).
SELECT
  (SELECT COUNT(*) FROM employee_identifier WHERE id_type = 'national_id')               AS national_id_rows_pre_015,
  (SELECT COUNT(*) FROM employee_identifier
     WHERE id_type = 'national_id' AND id_value REGEXP '^[0-9]{13}$')                    AS legacy_plaintext_national_rows,
  (SELECT COUNT(*) FROM employee_identifier
     WHERE id_type <> 'national_id' AND id_value REGEXP '^[0-9]{13}$')                   AS thirteen_digit_values_in_other_types,
  (SELECT COUNT(*) FROM (SELECT employee_uid FROM employee_identifier
     WHERE id_type = 'national_id' GROUP BY employee_uid HAVING COUNT(*) > 1) m)         AS employees_with_multiple_national_rows,
  (SELECT COUNT(*) FROM (SELECT id_type, id_value FROM employee_identifier
     GROUP BY id_type, id_value HAVING COUNT(*) > 1) d)                                  AS duplicate_type_value_groups,
  (SELECT COUNT(*) FROM employee_identifier i
     LEFT JOIN employees e ON e.employee_uid = i.employee_uid WHERE e.employee_uid IS NULL) AS orphan_identifier_rows,
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
       AND INDEX_NAME = 'uk_employee_identifier_type_value') = 0                         AS missing_unique_key_from_013,
  VERSION()                                                                               AS server_version;
-- Any non-zero count (other than server_version): STOP.
-- legacy_plaintext_national_rows / national_id_rows_pre_015 > 0 => apply 015, expect the CHECK step to
-- fail by design, run the approved reindex (planReindex; legacy rows are their own raw), then rerun 015.
