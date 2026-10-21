-- 027 PREFLIGHT (read-only) — run this BEFORE applying database/proposals/027_employee_uid_uuid_v4.up.sql.
--
-- It answers three questions, in this order, and writes nothing:
--   1. Does the UUIDv4 pattern behave on THIS engine the way the proposal assumes?
--   2. How many existing employees.employee_uid values would violate the constraint? (must be 0 to proceed)
--   3. Is the constraint already present? (then 027 is a no-op and you are done)
--
-- Read-only: SELECT statements only. No DDL, no DML, no temporary table.
-- employee_uid is an internal surrogate key, not personal data, but offenders are printed masked anyway.

-- 1. Pattern smoke tests -------------------------------------------------------------------------------
-- These do not depend on UUID() because MySQL/MariaDB UUID() returns a version-1 value, not version 4.
SELECT 'accepts_a_v4' AS probe,
  IF('11111111-1111-4111-8111-111111111111' REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', 'PASS', 'FAIL') AS result
UNION ALL
SELECT 'rejects_version_1',
  IF('f47ac10b-58cc-1372-a567-0e02b2c3d479' REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', 'FAIL', 'PASS')
UNION ALL
SELECT 'rejects_wrong_variant',
  IF('11111111-1111-4111-1111-111111111111' REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', 'FAIL', 'PASS')
UNION ALL
SELECT 'rejects_non_uuid',
  IF('RAE-00000001' REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', 'FAIL', 'PASS')
UNION ALL
SELECT 'rejects_trailing_space',
  IF('11111111-1111-4111-8111-111111111111 ' REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', 'FAIL', 'PASS');

-- 2. Existing data -------------------------------------------------------------------------------------
SELECT COUNT(*) AS employees_total FROM employees;

SELECT COUNT(*) AS employees_nonconforming
FROM employees
WHERE NOT (
  CHAR_LENGTH(employee_uid) = 36
  AND employee_uid REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
);

-- Offenders. A nonconforming employee_uid is, by definition, a value nobody expected: it may be a HIP code, an
-- employee code or a national ID that was pasted into the primary key. So nothing that could identify a person
-- is selected — no prefix, no suffix, no length-and-pattern pair that narrows it down. Only a count, a length
-- bucket and a keyed digest so the same row can be matched across two runs.
SELECT
  CHAR_LENGTH(employee_uid) AS uid_length,
  CASE
    WHEN CHAR_LENGTH(employee_uid) <> 36 THEN 'length'
    WHEN SUBSTRING(employee_uid, 15, 1) <> '4' THEN 'version_nibble'
    WHEN SUBSTRING(employee_uid, 20, 1) NOT IN ('8', '9', 'a', 'b', 'A', 'B') THEN 'variant_nibble'
    ELSE 'charset_or_format'
  END AS likely_reason,
  SHA2(employee_uid, 256) AS uid_digest
FROM employees
WHERE NOT (
  CHAR_LENGTH(employee_uid) = 36
  AND employee_uid REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
)
ORDER BY uid_digest
LIMIT 50;

-- 3. Current constraint state --------------------------------------------------------------------------
SELECT COUNT(*) AS constraint_present
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'employees'
  AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
  AND CONSTRAINT_TYPE = 'CHECK';

-- Also report whether any attendance rows are reachable without an employees row. This is context for why the
-- proposal must not "repair" a UID: daily_attendance and monthly_summary declare no FK to employees.
SELECT COUNT(*) AS daily_attendance_orphans
FROM daily_attendance d
LEFT JOIN employees e ON e.employee_uid = d.employee_uid
WHERE e.employee_uid IS NULL;
