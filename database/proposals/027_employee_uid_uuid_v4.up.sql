-- 027 (PROPOSAL, NOT APPLIED) — constrain employees.employee_uid to a version-4 UUID.
--
-- Status: PROPOSED — NOT APPROVED, NOT APPLIED, and NOT VERIFIED ON A REAL MARIADB SERVER by this change.
--         The workflow below is the evidence that would approve it; the pattern-smoke probes at the end are
--         there to be run on the target engine *before* the ALTER, because a regex that behaves differently on
--         the engine than in the author's head is exactly the class of bug this proposal exists to prevent.
-- Closes: R-F4a (ADR-012 §4) — the UUIDv4 rule is currently enforced by one code path, not by the schema.
-- Depends on: `employees` (002). Nothing else. Does not touch employee_identifier, its unique keys, the
--         namespace triggers, or any FK.
--
-- Why a CHECK and not a trigger
--   * MariaDB enforces CHECK from 10.2.3, which is already this repository's floor (migrations 015/020).
--   * A CHECK is declarative, visible in information_schema, and cannot be bypassed by a connection that has
--     INSERT privilege but not TRIGGER.
--   * A trigger would add a second place where the rule lives; the rule already lives in
--     `backend/src/domain/employeeUidAllocation.js`.
--
-- Why the pattern spells out both cases
--   `employees` uses utf8mb4_unicode_ci, so REGEXP may compare case-insensitively and a pattern containing
--   only a-f would accept A-F by accident. Spelling `[0-9a-fA-F]` makes the outcome identical under a _ci or a
--   _bin comparison, so this does not depend on the connection collation. Same reasoning for `[89abAB]`.
--
-- Why CHAR_LENGTH is part of the check
--   VARCHAR(36) can hold a 36-character value with trailing spaces, which `= ''` comparisons ignore but REGEXP
--   does not; and a shorter value could in principle satisfy a sloppy pattern. The length test makes the
--   intent explicit.
--
-- Safety
--   * Additive; guarded by information_schema, so a re-run is a no-op even if a partial failure leaves the
--     ledger without the filename.
--   * Fails closed on existing data: adding a CHECK validates existing rows, so one non-conforming row aborts
--     the migration instead of being silently accepted. Run `database/preflight/027_preflight.sql` first.
--   * No row is rewritten, deleted or backfilled. There is no "repair" step: a non-conforming UID is a policy
--     violation that a human must review, and rewriting a primary key could orphan attendance rows
--     (`daily_attendance` and `monthly_summary` declare no FK to `employees`).
--
-- Rollback: database/proposals/027_employee_uid_uuid_v4.down.sql

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_027_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- 1. The constraint -------------------------------------------------------------------------------------

-- UUID_V4_PATTERN: ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$

SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);

SET @ddl = IF(@has_check > 0, 'SELECT 1',
  'ALTER TABLE employees
     ADD CONSTRAINT chk_employees_employee_uid_uuid_v4
     CHECK (
       CHAR_LENGTH(employee_uid) = 36
       AND employee_uid REGEXP ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$''
     )');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

-- 2. Post-condition -------------------------------------------------------------------------------------
-- Expect: constraint_present = 1, nonconforming_after = 0.

SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SELECT @has_check AS constraint_present;

SELECT COUNT(*) AS nonconforming_after
FROM employees
WHERE NOT (
  CHAR_LENGTH(employee_uid) = 36
  AND employee_uid REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
);
