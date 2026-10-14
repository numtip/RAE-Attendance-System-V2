# Production schema reconciliation (Phase C4)

> **Point-in-time record (2026-10-09).** For current state read
> `docs/J2_SSO_EOD_HANDOFF_20261012.md`, which supersedes this file where they
> differ. The evidence below is not rewritten and its **NO-GO** verdicts stay in
> force. It does not cover later work (for example `019_sso_shared_claim.sql`
> and the opt-in shared claim store).

Date: 2026-10-09. Host `raeserver` (`10.1.245.190`). Source baseline `a6a18d5` in `/home/rae_admin/worktrees/RAE-Attendance-System-V2-integration`. Production database `attendance_v2` in container `rae-v2-mariadb`. This pass read `information_schema` only. It did not run `scripts/migrate.mjs`, did not write `schema_migrations`, and did not change the runtime.

**MERGE NO-GO. STAGING PILOT NO-GO. PRODUCTION SSO NO-GO.**

The filename gap from Phase C3 is the baseline. Object presence below was read from metadata. `TABLE_ROWS` was not used as a personnel count.

## Ledger and runner

Production `schema_migrations`, from Phase C2, contains `001` through `010` and `013_personnel_identifier.sql`. The runner in `scripts/migrate.mjs` stores the full filename and no checksum. Skip is an exact string match. Order is lexicographic. `--dry-run` prints every filename and does not read the ledger, so it is not schema validation.

Against that ledger a stock run would attempt, then stop at the first error:

1. `011_authorization_scope.sql`
2. `012_identity_links.sql`
3. `013_employee_identifier_foundation.sql`
4. skip `013_personnel_identifier.sql`
5. `014_facescan_raw_ingestion.sql`
6. `015_employee_identifier_secure_lookup.sql`
7. `015_facescan_hip_ingestion.sql`
8. `016_attendance_events.sql`
9. `017_identifier_namespace_claim.sql`
10. `018_sso_consumed_code.sql`

`013_employee_identifier_foundation.sql` sorts before the recorded `013_personnel_identifier.sql` because `e` precedes `p`. The two `015` files are separate versions. `018` runs only if every earlier missing file returns without throwing.

MariaDB commits DDL implicitly. The runner wraps the whole file and the version insert in one client transaction and calls `rollback()` on error. A DDL statement is not undone by that rollback. If an earlier statement in a file is DDL and a later statement fails, the schema change can remain while the version row is absent. This is engine behavior read from the runner code. It was not executed.

## Live metadata

`employee_identifier` exists. Its `id_type` is `enum('facescan_id','national_id','employee_id','personnel_id')`. Columns present: `id`, `employee_uid`, `id_type`, `id_value`, `is_primary`, `created_at`, `updated_at`. Unique key `uk_employee_identifier_type_value` is on (`id_type`, `id_value`). There is no foreign key on this table. Columns `source_system`, `status`, `verified_at`, `lookup_key_version`, and `national_id_owner_uid` are absent. Index `idx_employee_identifier_employee_type` is absent.

These tables are absent: `employee_org_membership`, `authorization_grants`, `identity_providers`, `employee_identity_links`, `facescan_import_batches`, `staging_facescan_raw`, `staging_facescan_users`, `employee_identifier_secret`, `employee_identifier_access_audit`, `attendance_events`, `employee_identifier_namespace_claim`, `sso_consumed_code`.

`information_schema.TRIGGERS` for `attendance_v2` has count 0.

The account used for this read shows `USAGE` only in the visible user-privilege catalog. `TRIGGER`, `SUPER`, `CREATE`, `ALTER`, `DROP`, and `ALL PRIVILEGES` are not in that catalog, nor in schema or table privileges for `attendance_v2`. One role is enabled, and its grants are not visible in those catalogs. Trigger privilege for a future migrate account stays **unproven**. `log_bin` remains OFF from Phase C2, so the binary-log trust setting is not the condition that applies on this server today.

## Compatibility matrix

`compatible` here means the named objects are absent and this file would be adding them, or a `DROP IF EXISTS` has no current target. It is not approval to run the file.

| File | Expected | Actual | Result | Risk | Later action |
|---|---|---|---|---|---|
| `011_authorization_scope.sql` | `employee_org_membership`, `authorization_grants` | Both absent | compatible | Unconditional `CREATE` inside the unapproved chain | Do not apply on production |
| `012_identity_links.sql` | `identity_providers`, `employee_identity_links`, two foreign keys | Both tables absent | compatible | File also inserts one provider catalog row. That row was not read | Do not apply on production |
| `013_employee_identifier_foundation.sql` | Columns `source_system`, `status`, `verified_at`; enum order `employee_id`, `personnel_id`, `facescan_id`, `national_id`; unique key of that name; `idx_employee_identifier_employee_type`; `fk_employee_identifier_employee` | Unique key already present. Enum already contains `personnel_id` in a different order. The three columns, the extra index, and the foreign key are absent | **conflict** | Unconditional `ADD UNIQUE KEY` hits an existing key. `MODIFY` of `id_type` would reorder the enum. Implicit commit can leave a partial alter with no version row | Do not run this file. A future change needs a new reviewed script |
| `013_personnel_identifier.sql` | HEAD body is `SELECT 1`. At `9ceb6ac` the same name conditionally added `personnel_id` and a unique key | Filename is in the ledger. Live enum order matches that historical list. Which body ran is not in the ledger | **unknown** | The current no-op does not describe the live enum. The ledger has no checksum | Do not invent a version row and do not re-apply a guessed body |
| `014_facescan_raw_ingestion.sql` | `facescan_import_batches`, `staging_facescan_raw` | Both absent | compatible | No staging rows exist under these names because the tables are absent | Do not create them on production in this phase |
| `015_employee_identifier_secure_lookup.sql` | `lookup_key_version`, `national_id_owner_uid`, check and unique key, `employee_identifier_secret`, `employee_identifier_access_audit` | All absent. Adds are guarded in the file | compatible | Still an identifier-table change. Not approved | Separate approval only |
| `015_facescan_hip_ingestion.sql` | `DROP TABLE IF EXISTS` the two 014 tables, then create those names in the HIP shape plus `staging_facescan_users` | All three names absent | drop has no current target | The drop would not remove an existing staging table, because neither 014 table is present. The creates are still new objects, and the file sits in the unapproved chain | Do not run |
| `016_attendance_events.sql` | `attendance_events` and foreign keys to employees and to the HIP staging tables | Table absent. HIP staging tables absent. `employees` is already part of the applied 001–010 set | depends on 015 HIP | Run alone, the foreign keys to staging tables fail. Stock order reaches it only after 015 HIP | Do not run ahead of an approved 015 HIP |
| `017_identifier_namespace_claim.sql` | `employee_identifier_namespace_claim` and three triggers on `employee_identifier` | Table and triggers absent. Base table and `personnel_id` / `facescan_id` enum members exist. Trigger grant is not visible | **unknown** privilege | Creating triggers with the account used here is not shown to be permitted. `log_bin` OFF does not add the binary-log requirement | Do not change privileges. Do not apply |
| `018_sso_consumed_code.sql` | `sso_consumed_code` (`code_digest`, `expires_at`, `claimed_at`, expiry index) | Table absent | compatible as a new table | The stock runner does not reach this file until 011–017 succeed. The SQL itself does not alter HIP, attendance, or leave tables | Isolated staging database only. Not production |

## HIP attendance and leave

Pending files 014, 015 HIP, and 016 state that they do not write `daily_attendance`. None of 011–018 alters `employee_leave` or `leave_balance`. Those leave tables remain the ones recorded by the applied 006 and 007 filenames. 017's triggers observe `employee_identifier` writes for `facescan_id` and `personnel_id`. They do not change leave rules. No leave or attendance rows were read.

## Release prerequisites

All of these are unmet.

| Prerequisite | Status |
|---|---|
| Root crontab and the bodies of `backup_db.sh` and `kri_collect.sh` show no pull and no migrate | **ACCESS BLOCKED** from Phase C2. Not re-checked |
| Runtime image revision is a full git SHA in `org.opencontainers.image.revision` | **UNKNOWN**. Tag `abb2792` is not a SHA. No rebuild in this phase |
| `013_employee_identifier_foundation.sql` is not pointed at this database | **Not met** as a guard. The file conflicts with the live unique key and enum order |
| Body that produced the recorded `013_personnel_identifier.sql` | **UNKNOWN** |
| Trigger privilege of the future migrate account | **Unproven** in the catalogs visible to this read |
| Stock `migrate.mjs` against production | **Not approved** |
| Staging database other than `rae-v2-mariadb` | **Not created** |
| Login CSRF closed and SSO flags enabled | **Not met**. Flags stay off |

A metadata match on absent tables does not make a merge, a staging pilot, or production SSO acceptable.
