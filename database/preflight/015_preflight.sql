-- READ-ONLY preflight for 015_employee_identifier_secure_lookup.sql. Run before migrating; every value must be 0.
-- Never SELECT id_value for national_id rows (could be legacy plaintext) — counts only.
SELECT
  (SELECT COUNT(*) FROM employee_identifier
     WHERE id_type = 'national_id' AND id_value NOT REGEXP '^[0-9a-f]{64}$')            AS national_rows_not_hmac_format,
  (SELECT COUNT(*) FROM (SELECT id_type, id_value FROM employee_identifier
     GROUP BY id_type, id_value HAVING COUNT(*) > 1) d)                                  AS duplicate_type_value_groups,
  (SELECT COUNT(*) FROM employee_identifier i
     LEFT JOIN employees e ON e.employee_uid = i.employee_uid WHERE e.employee_uid IS NULL) AS orphan_identifier_rows,
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identifier'
       AND INDEX_NAME = 'uk_employee_identifier_type_value') = 0                         AS missing_unique_key_from_013;
-- If national_rows_not_hmac_format > 0: STOP. Do not rewrite in SQL; reindex via the approved
-- application procedure (docs/NATIONAL_ID_PROTECTION_POLICY.md, "Reindex") then rerun preflight.
