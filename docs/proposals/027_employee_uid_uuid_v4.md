# Proposal 027 — constrain `employees.employee_uid` to a version-4 UUID

**Status:** `PROPOSED` — **NOT APPROVED, NOT APPLIED, NOT VERIFIED ON A REAL MARIADB SERVER.**
**Date:** 2026-10-21 · **Closes:** R-F4a ([ADR-012](../adr/ADR-012-employee-uid-allocation-policy.md) §4/§7)
**Depends on:** `employees` (`002`). Nothing else.

## Why this is a Markdown document and not a `.sql` file

`scripts/secret-scan.mjs` deliberately blocks **every** `.sql` file that is not under
`database/migrations/`, `database/seeds/` or `database/rollbacks/`, and `.gitignore` ignores `*.sql` outside
those trees. That is a control, not an oversight: unreviewed DDL must not enter the repository as SQL. Placing
this proposal in `database/proposals/` would either fail the secret-scan job or require weakening the scanner —
neither of which belongs in an F4 change.

A Markdown document satisfies both constraints: it is reviewable in the PR diff, and the migration runner reads
only `database/migrations/`, so nothing here can ever be applied by accident. When the owner approves this,
the SQL below is copied into `database/migrations/027_employee_uid_uuid_v4.sql` under the normal migration gate.

## Why a `CHECK` and not a trigger

* MariaDB enforces `CHECK` from **10.2.3**, which is already this repository's floor (migrations `015`/`020`).
* A `CHECK` is declarative and visible in `information_schema`, and it cannot be bypassed by a connection that
  holds `INSERT` privilege but not `TRIGGER`.
* A trigger would create a second place where the rule lives. The rule already lives in
  `backend/src/domain/employeeUidAllocation.js`.

## Why the pattern spells out both cases

`employees` uses `utf8mb4_unicode_ci`, so `REGEXP` may compare case-insensitively and a pattern containing only
`a-f` would accept `A-F` by accident. Writing `[0-9a-fA-F]` (and `[89abAB]`) makes the result identical under a
`_ci` or a `_bin` comparison, so it does not depend on the connection collation.

## Why `CHAR_LENGTH` is part of the check

`VARCHAR(36)` can hold a 36-character value with trailing spaces, which `=` comparisons ignore but `REGEXP` does
not; and a shorter value could satisfy a sloppy pattern. The length test makes the intent explicit.

## Safety properties

* **Additive** and **idempotent** (guarded by `information_schema`), matching the style of migration `020`.
* **Fails closed on existing data**: adding a `CHECK` validates existing rows, so a single non-conforming row
  aborts the migration instead of being silently accepted.
* **No repair step, ever.** A non-conforming UID is a policy violation for a human to review. Rewriting a primary
  key could orphan attendance rows, because `daily_attendance` and `monthly_summary` declare **no** FK to
  `employees`.
* The preflight is **read-only** (SELECT only) and never selects any part of a UID: a nonconforming value may be
  a pasted code or national ID, so offenders are identified by length, a reason bucket and `SHA2(…,256)`.

## Up

```sql
-- 027 — constrain employees.employee_uid to a version-4 UUID.
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
```

## Down

```sql
-- Rollback for 027 — drop the UUIDv4 shape constraint. Removes a constraint only; the constraint never
-- rewrote a row, so there is nothing to restore. Safe to run twice.
SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);

SET @ddl = IF(@has_check = 0, 'SELECT 1',
  'ALTER TABLE employees DROP CONSTRAINT chk_employees_employee_uid_uuid_v4');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @has_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SELECT @has_check AS constraint_present_after_rollback;
```

## Preflight (read-only — run this first)

```sql
-- 027 preflight. SELECT only: no DDL, no DML, no temporary table.

-- 1. Pattern smoke tests on THIS engine. UUID() is not used as the positive probe because
--    MySQL/MariaDB UUID() returns a version-1 value, not version 4.
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

-- 2. Existing data. `employees_nonconforming` must be 0 to proceed.
SELECT COUNT(*) AS employees_total FROM employees;

SELECT COUNT(*) AS employees_nonconforming
FROM employees
WHERE NOT (
  CHAR_LENGTH(employee_uid) = 36
  AND employee_uid REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
);

-- Offenders: no prefix, no suffix, no raw value. A nonconforming UID may be a pasted code or national ID.
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

-- 3. Constraint state, and orphan context (why a UID must never be "repaired" by rewrite).
SELECT COUNT(*) AS constraint_present
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'employees'
  AND CONSTRAINT_NAME = 'chk_employees_employee_uid_uuid_v4'
  AND CONSTRAINT_TYPE = 'CHECK';

SELECT COUNT(*) AS daily_attendance_orphans
FROM daily_attendance d
LEFT JOIN employees e ON e.employee_uid = d.employee_uid
WHERE e.employee_uid IS NULL;
```

## Evidence required before approval

1. The preflight run on the target engine: all five probes `PASS`, `employees_nonconforming = 0`.
2. The ALTER applied and the rollback exercised on a **disposable** MariaDB (same requirement as F7).
3. `constraint_present = 1` and `nonconforming_after = 0` afterwards.

Until then, R-F4a stays open: the UUIDv4 rule is enforced by one code path, not by the schema.

## Known preconditions (found by inspection — do not relax the constraint to satisfy them)

| # | Finding | Consequence |
|---|---|---|
| 1 | `database/seeds/dev-fixtures.sql` seeds three employees whose `employee_uid` values have version nibbles **1, 2 and 3** (variants 1, 2, 3). | Applying this `CHECK` to a seeded database **must fail**, because a `CHECK` validates existing rows. That is the control working. Fix the seed in a separate change; never weaken the constraint for a fixture. |
| 2 | `scripts/data-recovery/rehearse_fy2569_import.py` generates **uuid5** rehearsal UIDs (`uuid.uuid5(...)`). | An F7 rehearsal import run *after* `027` would be rejected for all 54 rows. Run F7 first, or move the rehearsal key to v4 under its own approval. |

## Rehearsal sequence this proposal expects

1. Provision a **disposable** MariaDB (`--bind-address=127.0.0.1`, non-default port, throwaway root password), outside the repo.
2. `TZ=UTC`; **one test file per process**; a **fresh database per run**.
3. Baseline: apply `database/migrations/*.sql` twice and assert the second run is all `skip` (ledger idempotency).
4. Run this preflight. Gate: 5/5 probes `PASS`, `employees_nonconforming = 0`.
5. Apply the up block via a client (not the runner, so the ledger is untouched). Assert `constraint_present = 1`.
6. Re-run the up block → still exactly one constraint (idempotency).
7. Enforcement: a v1 UUID and a non-UUID string must be rejected; a valid v4 must be accepted.
8. Rollback → `constraint_present = 0`; re-run → still 0; row counts and a checksum fingerprint **unchanged**;
   a non-v4 insert now **succeeds** (proves removal). Re-apply → must **fail** while that probe row exists
   (fail-closed on existing data); delete the probe (disposable only) and re-apply → 1.
9. With `027` applied, insert a `daily_attendance` row whose `employee_uid` does not exist in `employees` and
   assert it is **accepted** — `004_daily_attendance.sql` declares no FK. Do not add one to make a test pass.
10. Teardown: shut down, delete the datadir, confirm no listener, and confirm `git status` is unchanged.
