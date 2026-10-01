# DB recovery lab report

Date: 2026-10-01. **Lab only.** No production datadir access, writes, or file changes were performed from this repository run.

## Safety attestation

| Check | Result |
|---|---|
| Production DB writes | **0** |
| Production original `.ibd` / `.frm` / `ibdata1` changed | **No** |
| `IMPORT TABLESPACE` on production | **Not run** |
| Personal row data in this report | **None** |

## Context (read-only evidence)

Root cause of live unreadability is documented in `DB_EMPLOYEES_1932_INVESTIGATION.md`: InnoDB system tablespace reinitialized on **2026-06-02 05:02** while per-table `.frm` / `.ibd` files remained. `innodb_file_per_table=ON`. InnoDB dictionary has **zero** `attendance_db` entries.

MariaDB on production host (from prior read-only checks): **10.x** family; exact patch level recorded on legacy host, not repeated here.

### Inventory highlights (`attendance_db`)

Evidence below is from **read-only** inspection on 2026-10-01 (see investigation doc). A full per-table listing should be regenerated on a **copy** with `database/recovery-lab/scripts/inventory-evidence.sh`.

| Artifact | Size (bytes) | mtime (UTC) | Notes |
|---|---:|---|---|
| `employees.frm` | 11,139 | 2026-01-15 | Schema metadata present |
| `employees.ibd` | 229,376 | **2026-02-09** | Orphan tablespace candidate |
| `ibdata1` (system) | 12,582,912 | **2026-06-02 05:02** | New InnoDB instance signature |
| `staging_facescan_daily.ibd` | ~20 MiB | (on disk) | Largest orphan candidate mentioned in investigation |

All base tables show `ENGINE` null and engine comment `doesn't exist in engine` in `information_schema.TABLES`.

### InnoDB settings (relevant)

| Setting | Value (evidence) |
|---|---|
| `innodb_file_per_table` | ON |
| Dictionary entries for `attendance_db` | 0 in `INNODB_SYS_TABLES` |

## Backup / logical dump search (limited scope)

Scope: dumps **after 2026-02-09**, backup archives, cron/rsync/borg/mysql dump scripts. No new broad forensic trawl.

| Source | Result |
|---|---|
| `real-attendance-system/database/backup/attendance_db_backup_20251125_024132.sql` | **Found** on legacy tree (not in this repo). ~12 KiB, 8× `CREATE TABLE`, 4× `INSERT` — **not** a full data backup |
| Dump after 2026-02-09 with full row data | **Not found** in scoped search |
| New backup archive in repo | **None** (by design) |

**Conclusion:** No post–2026-02-09 logical dump suitable as primary restore path was identified. Recovery depends on **orphan `.ibd` import in an isolated lab** or discovery of a fuller dump outside this scan.

## Lab environment (this run)

- Isolated datadir: `/tmp/recovery-lab/datadir` (not production)
- MariaDB **10.11.14**, `--skip-networking`, unix socket only
- Scripts: `database/recovery-lab/` (inventory, import workflow, synthetic POC)

Synthetic round-trip `DISCARD TABLESPACE` → copy `.ibd` → `IMPORT TABLESPACE` on a minimal table did **not** complete cleanly in this VM (error 1034 on import). That does **not** disprove orphan recovery for production copies; it indicates tablespace alignment (internal table id, `.cfg` / export metadata, exact DDL) must match the orphan file. Production recovery must use **copied** `employees.ibd` etc. with DDL verified from `docs/CURRENT_DATABASE_SCHEMA.md` or `.frm` parsing on the copy.

## Target tables — recovery status

Production orphan files were **not** copied into the cloud agent environment, so **no production `.ibd` import was attempted**.

| Table | Status | Evidence / next step |
|---|---|---|
| `employees` | **Not attempted** (lab) | `.ibd` mtime 2026-02-09; priority 1. Recreate DDL on copy, then `import-tablespace-workflow.sh` |
| `daily_attendance` | **Not attempted** (lab) | Schema verified in `CURRENT_DATABASE_SCHEMA.md` |
| `monthly_summary` | **Not attempted** (lab) | Same |
| `leave_balance` | **Not attempted** (lab) | Same |
| `staging_leave` | **Not attempted** (lab) | Omit sensitive columns in any future export |
| Other base tables | **Not attempted** | Same orphan class as `employees` |
| Views | **Failed** (production) | Depend on broken base tables (1932) |

If a lab import succeeds, validate **row counts and checksums only** in the lab; export **logical SQL** into a **clean V2 database**. Do not attach recovered tablespaces to production.

## Recommended recovery path

1. **Copy** (rsync snapshot) entire `attendance_db` directory + note `ibdata1` size/mtime — **read-only at source**.
2. Run `inventory-evidence.sh` on the copy; store output outside git if it includes paths tied to production.
3. Stand up isolated MariaDB (`database/recovery-lab/README.md`).
4. For each priority table: create matching DDL → `DISCARD TABLESPACE` → attach **copy** of orphan `.ibd` → `IMPORT TABLESPACE` → verify counts.
5. **Logical export** (`mysqldump` / ETL) from lab into V2 clean schema.
6. Retire legacy broken instance as runtime; keep files as evidence only.

See `PROJECT_DIRECTION.md` — legacy files are **not** the V2 runtime database.

## V2 development rule (locked)

> Legacy production database files are recovery evidence/data source only, not the future runtime database.

Flow: `legacy files → isolated recovery → logical export → clean V2 database`.
