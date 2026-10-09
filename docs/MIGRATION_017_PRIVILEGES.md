# Migration 017 - privileges, binary logging and operations

Verified on disposable MariaDB 10.3.39 and 10.11.9 started with binary logging (`--log-bin`, `ROW` and `STATEMENT`, `log_bin_trust_function_creators=0`) by `backend/tests/migration017.privileges.mariadb.test.js` (opt-in: `RAE_QA_BINLOG_PORTS`) and `backend/tests/namespaceClaim.mariadb.test.js`. Production settings were not touched or inspected.

| Situation | Result (both versions) | Action |
|---|---|---|
| Migration user has `TRIGGER` but not `SUPER`, binlog on, trust=0 | **fails with error 1419** at `CREATE TRIGGER`; no trigger is left; the application keeps working (no guard yet) | DBA decision: run as an account holding `SUPER`, **or** set `log_bin_trust_function_creators=1`. The migration never changes server variables. Rerun is idempotent |
| Migration user lacks `TRIGGER` | fails with error 1142; nothing active | grant `TRIGGER` on the schema, rerun |
| Account holding `SUPER` | succeeds; server variable unchanged | - |
| Binlog off, or trust=1 | succeeds | - |
| Application account (table-level `SELECT/INSERT/UPDATE/DELETE` on `employee_identifier` only) | writes work, collisions refused (SQLSTATE 45000); it can neither read nor modify the claim table | do **not** grant schema-wide rights on the claim table to the application account |
| Triggers run as their `DEFINER` (the migrating account) | **dropping/renaming the definer account makes every identifier write fail with error 1449** | run the migration as a stable service account, never as a personal account that may be removed; recovery = recreate the definer or rerun 017 with another account |
| ROW and STATEMENT binlog | concurrency suite passes on all four server variants | - |

Preflight (`database/preflight/017_preflight.sql`) is read-only and now also reports `binlog_enabled`, `binlog_format` and `log_bin_trust_function_creators`; collisions must be 0 before migrating. Rollback: `database/rollbacks/017_identifier_namespace_claim.down.sql`.

Numbering: `origin/main` contains 013 (`013_employee_identifier_foundation.sql`) and 014; PR #30 adds 015 and, through commit `9ceb6ac`, a second 013 file (`013_personnel_identifier.sql`); 017 is chosen so that the unmerged `feat/facescan-ingestion-phase-a` files `015_facescan_hip_ingestion.sql` and `016_attendance_events.sql` keep their numbers. If that branch merges first, renumber 015 (PR #30) or coordinate before merge. The migration runner keys its ledger by filename, so gaps are harmless, but two files with the same number are not (the duplicate `013_*` in the PR #30 lineage is therefore a hygiene item to resolve in PR #30, not a blocker for the runner).
