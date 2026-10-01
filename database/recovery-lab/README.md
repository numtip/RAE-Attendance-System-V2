# Legacy InnoDB recovery lab (isolated)

Production `attendance_db` datadir files are **recovery evidence only**. Never run these steps against the original production datadir.

Operator guide: **`docs/DB_RECOVERY_EXECUTION_RUNBOOK.md`**.

## Safety

- Use a **copy** of `.frm` / `.ibd` files in a directory you control (`LAB_EVIDENCE_DIR` must include a lab path marker).
- Run MariaDB with a **separate datadir** (`LAB_DATADIR`), `--skip-networking`, and no production credentials.
- Scripts **refuse** `/var/lib/mysql` production paths, in-place `attendance_db` on production datadir, and TCP exposure (`RECOVERY_LAB_ALLOW_TCP` is blocked).
- Set `DRY_RUN=1` to preview DISCARD/IMPORT and exports without writing.
- Do not commit copies, dumps, or row extracts into this repository.

## Quick start (operator)

```bash
export LAB_EVIDENCE_DIR=/srv/recovery-lab/evidence/attendance_db
export LAB_DATADIR=/var/lib/mysql-recovery-lab
export LAB_SOCKET=/tmp/recovery-lab/socket/mysqld.sock

bash scripts/assert-lab-environment.sh
bash scripts/inventory-evidence.sh
bash scripts/checksum-evidence.sh
sudo bash scripts/start-lab-mariadb.sh
bash scripts/apply-recovery-ddl.sh
DRY_RUN=1 bash scripts/run-recovery-batch.sh   # then unset DRY_RUN for real run
bash scripts/validate-table-metadata.sh
bash scripts/logical-export-lab.sh
```

## Recovery order

`employees` → `daily_attendance` → `monthly_summary` → `leave_balance` → `staging_leave` (see `run-recovery-batch.sh`).

## Scripts

| Script | Role |
|---|---|
| `lib/safety-guards.sh` | Shared path and networking guards |
| `inventory-evidence.sh` | File sizes/mtimes on copy |
| `checksum-evidence.sh` | SHA-256 of `.frm`/`.ibd` copies |
| `assert-lab-environment.sh` | Pre-flight |
| `start-lab-mariadb.sh` | `skip-networking` lab instance |
| `apply-recovery-ddl.sh` | Apply `ddl/recovery_priority_tables.ddl` |
| `import-tablespace-workflow.sh` | DISCARD / copy `.ibd` / IMPORT |
| `run-recovery-batch.sh` | Priority tables in order |
| `validate-table-metadata.sh` | Counts/metadata only |
| `logical-export-lab.sh` | mysqldump to lab export path |
| `import-logical-to-v2.sh` | Load export into clean V2 DB |
| `poc-transportable-tablespace.sh` | Synthetic technique proof |

Operator steps: **`docs/DB_RECOVERY_EXECUTION_RUNBOOK.md`**.

## Technique proof

`scripts/poc-transportable-tablespace.sh` runs a synthetic import/export cycle on the local lab socket. It does not use production files.
