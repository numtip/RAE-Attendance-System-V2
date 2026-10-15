# 08 — Migration dependency graph

Part of the Phase 0/1 document set for [RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md](../../RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md).
Companion documents: [`07_SLICE2_ATTENDANCE_ENGINE.md`](07_SLICE2_ATTENDANCE_ENGINE.md), [`../ATTENDANCE_RULES.md`](../ATTENDANCE_RULES.md).

**Why this document exists:** the repository carries **23** migration files, two pairs sharing a numeric
prefix, and the runner's ledger keys on the **full filename** with no checksum. That combination is safe
only while the dependencies between files are written down somewhere. This is that record.

Label legend: **VERIFIED** = read from the file/runner at the cited place; **INFERRED** = reasoned from the
schema; **UNKNOWN** = no evidence.

## 1. How the runner behaves (VERIFIED)

`scripts/migrate.mjs`:

* lists `database/migrations/*.sql` and sorts them **lexicographically by filename** (`listMigrationFiles`);
* records the full filename in `schema_migrations.version` — so two files may share a numeric prefix and
  both be tracked, and **renaming an applied file makes it look new**;
* applies any file whose name is not yet in the ledger, inside a transaction per file
  (`applyMigration`);
* has **no checksum**, so editing an already-applied file is silently ignored on the next run;
* DDL auto-commits in MariaDB, so a partial failure leaves the file **unapplied in the ledger** and the
  same file is simply re-run. This is why every Slice 1/2 migration is `information_schema`-guarded and
  idempotent rather than relying on rollback;
* `--seed` additionally runs `database/seeds/dev-fixtures.sql`, which **writes data**. Nothing else in the
  repository applies migrations; there is no auto-migrate on the production hosts (REPORTED, operator
  pass 2026-10-14).

## 2. Order and dependencies

Files sort in this order. "Depends on" means the file will fail or be meaningless without the other.

| # | File | Depends on | Adds | Notes |
|---|---|---|---|---|
| 1 | `001_schema_migrations.sql` | — | ledger table | |
| 2 | `002_employees.sql` | 001 | `employees` | root of nearly every FK |
| 3 | `003_employee_identifier.sql` | 002 | `employee_identifier` | pre-uniqueness version |
| 4 | `004_daily_attendance.sql` | 002 | `daily_attendance` | **no unique key on (employee_uid, date)** until 023 |
| 5 | `005_monthly_summary.sql` | 002 | `monthly_summary` | no writer |
| 6 | `006_employee_leave.sql` | 002 | `employee_leave` | verified-leave source for Slice 2 |
| 7 | `007_leave_balance.sql` | 002 | `leave_balance` | |
| 8 | `008_refresh_tokens.sql` | 002 | `refresh_tokens` | |
| 9 | `009_auth_logs.sql` | — | `auth_logs` | |
| 10 | `010_system_logs.sql` | — | `system_logs` | |
| 11 | `011_authorization_scope.sql` | 002 | `authorization_grants`, `employee_org_membership` | drives `resolveScope` |
| 12 | `012_identity_links.sql` | 002 | `identity_providers`, `employee_identity_links` | seeds provider `mju_sso` |
| 13 | `013_employee_identifier_foundation.sql` | 003 | FK, `UNIQUE(id_type,id_value)`, `personnel_id`, status/verified_at | **conflicts with a populated pre-013 DB** |
| 14 | `013_personnel_identifier.sql` | — | no-op `SELECT 1` | stub so an older ledger stays consistent |
| 15 | `014_facescan_raw_ingestion.sql` | 002 | first FaceScan staging (superseded) | tables dropped by 015 |
| 16 | `015_employee_identifier_secure_lookup.sql` | 013 | `lookup_key_version`, national_id CHECK, owner key, `employee_identifier_secret`, `employee_identifier_access_audit` | needs MariaDB ≥ 10.2.3 |
| 17 | `015_facescan_hip_ingestion.sql` | 002 | **drops** 014 staging tables, creates batch + raw + users | safe only while 014 is empty |
| 18 | `016_attendance_events.sql` | 015_facescan, 002 | `attendance_events` | needs `staging_facescan_raw` + `facescan_import_batches` |
| 19 | `017_identifier_namespace_claim.sql` | 013 | claim table + 3 triggers | triggers need `SUPER` or `log_bin_trust_function_creators=1` |
| 20 | `018_*` / `019_*` | — | **not in this branch** | reserved by draft PR #35 |
| 21 | `020_employee_assignment_effective_dating.sql` | 002, 013, 015 | `employee_assignment`; `effective_from`/`effective_to` on `employee_identifier` + audit; `effective_change` action | Slice 1 |
| 22 | `021_facescan_ingestion_provenance.sql` | 015_facescan | `file_name`, `input_sha256`, `parser_version`, `column_map_json` on `facescan_import_batches` | Slice 1 |
| 23 | `022_attendance_rule_versioning.sql` | 002 | `attendance_rule_version`, `attendance_holiday`, `attendance_schedule` | Slice 2 |
| 24 | `023_daily_attendance_provenance.sql` | 004, 016 | 12 provenance columns on `daily_attendance`, `UNIQUE(employee_uid,date)`, `daily_attendance_source_event` (FK to `attendance_events`), `status` ENUM gains `pending` | Slice 2 |

## 3. Prefix collisions (deliberate, do not "fix" by renaming)

| Prefix | Files | Why both exist |
|---|---|---|
| `013_` | `..._employee_identifier_foundation.sql`, `..._personnel_identifier.sql` | The second is a no-op stub for a ledger that recorded an earlier DDL. Never on `main`. |
| `015_` | `..._employee_identifier_secure_lookup.sql`, `..._facescan_hip_ingestion.sql` | Unrelated features that happened to land together. Lexicographic order is deterministic and there is no cross-dependency. |
| `018_`/`019_` | not present here | Claimed by draft PR #35 (`018_sso_consumed_code.sql`, `019_sso_shared_claim.sql`). Slice 1 therefore started at `020`. |

**ADR-008 (carried from the handoff): never rename an applied migration.** A rename is a ledger change and
needs its own coordinated plan, because `schema_migrations` stores the filename.

## 4. Deploy-order constraints and standing hazards (the ones that can break a running system)

**Standing hazard — `Date` versus string.** MariaDB returns a JS `Date` for a `DATE`/`DATETIME` column
(the pool sets `timezone: 'Z'`), while the fixture repositories return strings. **This has now caused a
defect in two consecutive slices** (Slice 1's CI failure; Slice 2's `groupEventsByDate`). Any code that
formats a stored date-like value must use `wallDateOnly()` / `splitWallDateTime()` from
`backend/src/utils/bangkokTime.js` and never `String(value).slice(0, 10)`. The fixture/MariaDB twin pattern
hides this class of bug from local tests, so the `backend-mariadb` CI job is the real check.

| Constraint | Consequence if violated | Evidence |
|---|---|---|
| **020 before the Slice 1 code** | The identifier repository selects `effective_from`/`effective_to` unconditionally, so **every** identifier lookup fails with `ER_BAD_FIELD_ERROR` — MJU SSO national-ID resolution and every FaceScan resolve. The same contract `015` already imposes. | `mariadb/employeeIdentifierMariaDbRepository.js` `COLUMNS` |
| **022 before the Slice 2 code** | The rule repositories and the new tables are absent; any calculation attempt fails. | `mariadb/attendanceRuleMariaDbRepository.js` |
| **023 before the Slice 2 code** | `daily_attendance` upserts fail on the missing columns, and `status='pending'` is rejected by the old 5-value ENUM. | `mariadb/dailyAttendanceMariaDbRepository.js`; migration 023 |
| **`015_facescan` only while 014 tables are empty** | It `DROP TABLE`s them; with data they are lost. | `015_facescan_hip_ingestion.sql:2-4` |
| **017 needs a privileged migration account when binary logging is on** | Error 1419 (or 1142 without TRIGGER). | `docs/MIGRATION_017_PRIVILEGES.md` |
| **`015_employee_identifier_secure_lookup` cannot run on a DB with legacy plaintext national IDs** | The CHECK aborts the file before the ledger row is written; re-runnable after an approved reindex. | migration 015 comments |

## 5. Production status — NOT APPLIED

* The live V2 ledger is **pre-`013`** while `main` and every open PR assume `013`–`017` (REPORTED, operator
  pass 2026-10-14). The stock runner therefore **cannot** be pointed at the live database: it would try to
  apply `013_employee_identifier_foundation.sql`, which conflicts with the live unique key and enum order.
* `011`, `012`, `014`–`019` are unapplied on the live host; `log_bin` is OFF there.
* **Migrations are NOT APPROVED.** No apply order is proposed in this document, and none should be inferred
  from the dependency table above — it records what *would* be needed, not a plan.
* Preflights are read-only: `database/preflight/015_preflight.sql`, `017_preflight.sql`. Rollbacks live in
  `database/rollbacks/` (and only `015`, `017`, `020`, `021`, `022`, `023` have one).

## 6. Verification state

| File | Verified how | Label |
|---|---|---|
| `001`–`019` | Applied on a disposable MariaDB by the pre-existing CI `backend-mariadb` job and, historically, in a throw-away lab (handoff §8) | VERIFIED for a fresh DB |
| `020`, `021` | Applied by the same CI job since PR #36, which is 8/8 green | VERIFIED for a fresh DB |
| `022`, `023` | Applied by the same CI job for Slice 2; `backend/tests/slice2.mariadb.test.js` asserts the columns, the new ENUM value, the real `DATETIME` round-trip and the transactional upsert | VERIFIED for a fresh DB |
| Any of them on a **populated** production database | Never attempted | **UNKNOWN** |
| Rollback files | Written and `information_schema`-guarded; **not executed anywhere** | **REPORTED** |
