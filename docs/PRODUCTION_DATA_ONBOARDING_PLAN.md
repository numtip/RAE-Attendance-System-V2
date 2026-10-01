# Production data onboarding plan

**Status:** Plan and dry-run tooling only. This document does not authorize a production import.

**Policy:** GitHub-first. Do not read or write the live `attendance_v2` database from this work. Do not repair the legacy InnoDB tablespace. Do not import tokens, sessions, password hashes, or national IDs.

The clean V2 schema `attendance_v2` (migrations 001–010) is empty on purpose. Rows enter only after a later, approved import.

## 1. Source hierarchy

Nothing below is marked authoritative. `docs/CURRENT_DATABASE_SCHEMA.md` read `information_schema` column metadata while `SHOW COLUMNS` on `employees` failed with `ERROR 1932`. That is a catalog snapshot, not a recovered row export.

| Order | Candidate | Evidence in this repo | Status |
|---|---|---|---|
| 1 | Recovered legacy logical export | Desired by `DATABASE_REUSE_PLAN.md` and `DB_RECOVERY_EXECUTION_RUNBOOK.md`. No dump is in git. Live engine reads are documented as failed. | **Not in hand.** Not authoritative. |
| 2 | Trusted employee master | No named external HR file, owner, or checksum is recorded. | **UNKNOWN** |
| 3 | Attendance source | Catalog tables `daily_attendance`, `monthly_summary`, `staging_facescan`, `staging_facescan_daily` are described. Facescan CSV import is deferred past Release 1. | **UNKNOWN** which extract, if any, is current |
| 4 | Leave source | `staging_leave` columns are listed from `information_schema`. V2 stores matched leave on `employee_leave`, not on `staging_leave`. | **UNKNOWN** whether a row export exists |
| 5 | Other verified exports | `canva_tokens` is out of scope. `report_audit_logs` is absent. No other verified file is named. | **None recorded** |

An operator must attach evidence (who produced the file, when, from which system, row counts, checksum) before a source can move above **UNKNOWN**.

## 2. Pipeline

```text
source file → staging JSON → validate → transform → dry-run report → human approval → import → reconcile
```

The scripts in `scripts/data-onboarding/` implement the steps through dry-run and reconcile. They do not connect to MariaDB.

| Property | How |
|---|---|
| Idempotent | Natural keys and `stableEmployeeUid(employee_id)` make a repeated dry-run identical. |
| Resumable | Pass a list of already applied `table:key` values. Those keys are reported as `skip`. |
| Dry-run | `import-dry-run.mjs` prints a plan and sets `writesDatabase: false`. |
| Rollback | The report lists `rollbackKeys` for rows the plan would insert. Deleting by those keys is a later approved step, not executed here. |
| Audit | Report includes source SHA-256, per-table counts, validation errors, and omitted secret fields. Values of secrets are not copied into the plan. |

Rejected forever at this layer:

- `password_hash` and plaintext passwords
- `refresh_tokens.token` and any legacy session
- `auth_logs` history
- `national_id_encrypted`, `raw_data`, `raw_row_json`
- `employee_identifier` rows with `id_type = national_id`

`refresh_tokens` and `auth_logs` stay empty until a person logs in on V2. `system_logs` is not an import target.

Role and org scope use `authorization_grants` and `employee_org_membership`. Codes are opaque. The importer does not derive a manager's staff from `department` or from any guessed unit tree. See `docs/DATA_MAPPING.md`.

## 3. Quality gates

`validate.mjs` fails the file when any of these occur:

- duplicate `employee_id` or email
- attendance, monthly, leave, or balance rows whose `employee_id` is not in the employee set
- dates that are not real `YYYY-MM-DD` values
- `check_out` before `check_in`
- two attendance rows for the same employee and date
- overlapping leave ranges for the same employee
- leave type outside the V2 `employee_leave` enum
- `remaining_days` not equal to `total_days - used_days`
- secret columns present

`reconcile.mjs` then compares the dry-run report with an expected checksum and row counts. A mismatch stops the gate.

Schema note: `daily_attendance` has no unique key on `(employee_uid, date)`. The dry-run enforces that key. A later migration may add the unique index. This plan does not add that migration and does not apply DDL on the VPS.

## 4. Commands

Synthetic sample only:

```bash
node scripts/data-onboarding/inspect-source.mjs scripts/data-onboarding/sample/synthetic-source.json
node scripts/data-onboarding/validate.mjs scripts/data-onboarding/sample/synthetic-source.json
node scripts/data-onboarding/transform.mjs scripts/data-onboarding/sample/synthetic-source.json
node scripts/data-onboarding/import-dry-run.mjs scripts/data-onboarding/sample/synthetic-source.json
node --test scripts/data-onboarding/onboarding.test.mjs
```

## 5. Approval gate before any VPS import

1. A named source file exists outside git, with owner, timestamp, and checksum.
2. Its authority is written down. Until then every source stays **UNKNOWN**.
3. Dry-run report is reviewed. Validation `ok` is true.
4. Reconcile against an expected count sheet passes.
5. A separate change window applies the plan to `attendance_v2`. This repository's scripts still do not perform that write.

Related: `docs/DATA_MAPPING.md`, `docs/DATA_IMPORT_VALIDATION.md`.
