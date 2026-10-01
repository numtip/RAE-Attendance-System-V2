# DB recovery execution runbook

Date: 2026-10-01. **Operator execution guide (VPS-last).** Scripts and DDL are maintained in GitHub; run on the VPS only after approval when CI cannot substitute. No production datadir writes. Work only on **copied** evidence on an isolated lab host.

## Scope and references

| Document | Purpose |
|---|---|
| `docs/DB_EMPLOYEES_1932_INVESTIGATION.md` | Root cause (orphan `.ibd` after `ibdata1` reinit) |
| `docs/DB_RECOVERY_LAB_REPORT.md` | Lab findings and safety attestation |
| `docs/CURRENT_DATABASE_SCHEMA.md` | Column-level DDL source of truth |
| `database/recovery-lab/` | Scripts, SQL, and guards |

**Target host for execution:** `10.1.245.190` (lab/recovery workstation — not the live app runtime). Adjust paths only if your lab layout differs; never point scripts at the original production datadir.

**End state:** Row data readable in an isolated MariaDB instance, validated by **counts and metadata only**, then **logical SQL export** into a **clean V2 database**. Legacy broken instance remains evidence-only.

## Forbidden vs allowed paths

Scripts refuse unsafe paths automatically (`database/recovery-lab/scripts/lib/safety-guards.sh`).

| Pattern | Treatment |
|---|---|
| `/var/lib/mysql` or `/var/lib/mysql/attendance_db` (live datadir) | **Forbidden** as `LAB_EVIDENCE_DIR`, import source, or `LAB_DATADIR` |
| Copied tree under a lab marker path | **Required** for evidence |
| Lab MariaDB datadir | Must include `recovery-lab`, `mysql-recovery-lab`, `lab-evidence`, or `LAB_` in the path |

**Example allowed layout on 10.1.245.190:**

```text
/srv/recovery-lab/evidence/attendance_db/     # LAB_EVIDENCE_DIR (.frm/.ibd copies)
/srv/recovery-lab/checksums/                  # SHA-256 lists (not in git)
/var/lib/mysql-recovery-lab/                  # LAB_DATADIR (empty InnoDB instance)
/tmp/recovery-lab/socket/mysqld.sock          # LAB_SOCKET (--skip-networking)
/tmp/recovery-lab/export/                     # logical dumps (not in git)
```

**Production datadir (read-only source for rsync only — never set as env vars):**

```text
/var/lib/mysql/attendance_db/   # DO NOT use as LAB_EVIDENCE_DIR; copy out first
/var/lib/mysql/ibdata1          # note size/mtime only; do not replace in lab from live path
```

## Evidence checklist (before real run)

Complete every item; keep artifacts **outside git** (no `.ibd`, `.frm`, dumps, or PII in the repository).

- [ ] Written approval to run copy-based recovery (change ticket / owner sign-off).
- [ ] **Read-only** rsync (or snapshot mount) of `attendance_db/` to `LAB_EVIDENCE_DIR` on `10.1.245.190`.
- [ ] Record `ibdata1` **size** and **mtime** from the copy’s parent directory (expect ~12 582 912 bytes, mtime **2026-06-02** per investigation — verify on copy).
- [ ] `bash database/recovery-lab/scripts/inventory-evidence.sh` — archive stdout under `/srv/recovery-lab/logs/`.
- [ ] `bash database/recovery-lab/scripts/checksum-evidence.sh` — store `.sha256` next to evidence.
- [ ] Confirm priority `.ibd` files exist: `employees`, `daily_attendance`, `monthly_summary`, `leave_balance`, `staging_leave`.
- [ ] MariaDB version on lab host documented (prefer **10.11.x** or match legacy 10.x; mismatch increases import risk).
- [ ] `DRY_RUN=1` batch dry run (see below) reviewed by second operator.
- [ ] Lab host has **no** required dependency on TCP `3306` for this work (`--skip-networking`).
- [ ] V2 target database name and socket for final import agreed (default script: `attendance_v2` on `LAB_V2_SOCKET`).

## Environment variables

| Variable | Example | Meaning |
|---|---|---|
| `LAB_EVIDENCE_DIR` | `/srv/recovery-lab/evidence/attendance_db` | Copied schema files |
| `LAB_DATADIR` | `/var/lib/mysql-recovery-lab` | Isolated InnoDB datadir |
| `LAB_SOCKET` | `/tmp/recovery-lab/socket/mysqld.sock` | Unix socket only |
| `LAB_RECOVERY_DATABASE` | `recovery_lab` | DB for import workflow |
| `LAB_V2_SOCKET` | `/tmp/v2-mariadb.sock` | Clean V2 instance socket |
| `V2_TARGET_DATABASE` | `attendance_v2` | Destination DB name |
| `DRY_RUN` | `1` | Print actions; no DISCARD/IMPORT/copy to datadir |

Optional: `LAB_CHECKSUM_FILE`, `LAB_EXPORT_FILE`.

## Step-by-step execution

### 1. Copy evidence (read-only at source)

On the **source** host, do not stop InnoDB for copy if policy forbids; prefer filesystem snapshot or cold copy per ops policy.

```bash
# Example: run from 10.1.245.190 after mounting read-only snapshot at /mnt/legacy-mysql
sudo rsync -aH --info=progress2 \
  /mnt/legacy-mysql/attendance_db/ \
  /srv/recovery-lab/evidence/attendance_db/
# Optional: copy ibdata1 metadata sibling for inventory script
sudo rsync -aH /mnt/legacy-mysql/ibdata1 /srv/recovery-lab/evidence/ibdata1.reference
sudo chown -R "$(whoami):$(whoami)" /srv/recovery-lab/evidence
```

Never rsync **into** `/var/lib/mysql/attendance_db` on a running production instance.

### 2. Inventory and checksums

```bash
cd /path/to/RAE-Attendance-System-V2
export LAB_EVIDENCE_DIR=/srv/recovery-lab/evidence/attendance_db

bash database/recovery-lab/scripts/inventory-evidence.sh | tee /srv/recovery-lab/logs/inventory-$(date -u +%Y%m%d).txt
bash database/recovery-lab/scripts/checksum-evidence.sh
```

### 3. Start isolated MariaDB (skip-networking)

```bash
export LAB_DATADIR=/var/lib/mysql-recovery-lab
export LAB_SOCKET=/tmp/recovery-lab/socket/mysqld.sock

sudo bash database/recovery-lab/scripts/start-lab-mariadb.sh
```

Verify: `ss -ltn | grep 3306` should show **no** lab listener (script also checks). Connection only via:

```bash
mariadb --socket="$LAB_SOCKET" -u root -e "SELECT @@port, @@datadir;"
```

Expect `@@port` **0** (skip-networking) and datadir under `mysql-recovery-lab`.

### 4. Pre-flight

```bash
export LAB_EVIDENCE_DIR=/srv/recovery-lab/evidence/attendance_db
export LAB_DATADIR=/var/lib/mysql-recovery-lab
export LAB_SOCKET=/tmp/recovery-lab/socket/mysqld.sock

bash database/recovery-lab/scripts/assert-lab-environment.sh
```

Optional synthetic proof (no production files):

```bash
bash database/recovery-lab/scripts/poc-transportable-tablespace.sh
```

### 5. Recreate verified DDL (empty shells)

DDL is versioned at `database/recovery-lab/ddl/recovery_priority_tables.ddl` (aligned with `docs/CURRENT_DATABASE_SCHEMA.md`).

```bash
bash database/recovery-lab/scripts/apply-recovery-ddl.sh
```

If `IMPORT TABLESPACE` fails with schema mismatch, diff against `.frm` on the **copy** (e.g. `mysqlfrm` on lab host) and adjust **lab SQL only** — do not alter production files.

### 6. Transportable import (copy `.ibd` only)

**Fixed recovery order** (dependencies and validation flow):

1. `employees`
2. `daily_attendance`
3. `monthly_summary`
4. `leave_balance`
5. `staging_leave`

Dry run:

```bash
export DRY_RUN=1
bash database/recovery-lab/scripts/run-recovery-batch.sh
unset DRY_RUN
```

Real run (per table or batch):

```bash
bash database/recovery-lab/scripts/run-recovery-batch.sh
# Or single table:
bash database/recovery-lab/scripts/import-tablespace-workflow.sh recovery_lab employees \
  "$LAB_EVIDENCE_DIR/employees.ibd"
```

On failure, capture **error code and table name** only in the log; do not paste row samples into tickets.

### 7. Validate counts and metadata (no PII in logs)

```bash
bash database/recovery-lab/scripts/validate-table-metadata.sh recovery_lab
```

Record `engine`, `COUNT(*)`, and `DATA_LENGTH` in `/srv/recovery-lab/logs/validation-*.txt`. Do **not** `SELECT *` or export sample names/emails into shared docs.

Cross-check: `employees` count should be consistent with downstream tables’ referential sanity (manual spot-check via `COUNT` only).

### 8. Logical export from lab

```bash
export LAB_EXPORT_FILE=/tmp/recovery-lab/export/recovery_lab-$(date -u +%Y%m%dT%H%M%SZ).sql
bash database/recovery-lab/scripts/logical-export-lab.sh
```

`staging_leave` export omits `national_id_encrypted` and `raw_data` when supported by local `mysqldump`; if the flag is unsupported, export that table with an explicit column list in a separate operator-only step.

Store exports encrypted at rest; **do not commit** to git.

### 9. Import into clean V2 database

On the V2 MariaDB instance (fixture replacement or dedicated V2 host):

```bash
export LAB_V2_SOCKET=/tmp/v2-mariadb.sock   # example
export V2_TARGET_DATABASE=attendance_v2
export LAB_EXPORT_FILE=/tmp/recovery-lab/export/recovery_lab-....sql

bash database/recovery-lab/scripts/import-logical-to-v2.sh
```

Re-run `validate-table-metadata.sh` against V2 (set `LAB_SOCKET` to V2 socket and database name) for parity of **counts** with lab.

### 10. Shutdown lab instance

```bash
mariadb --socket="$LAB_SOCKET" -u root -e "SHUTDOWN;"
```

Retain evidence copies and checksums per retention policy.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `ERROR 1930` / `1932` on production | Orphan tablespaces (documented) | Do not “fix” on production; continue on copy |
| `IMPORT TABLESPACE` failure | DDL mismatch, tablespace ID, missing `.cfg` | Compare DDL to `.frm`; consult MariaDB transportable tablespace docs for version |
| Script refuses `/var/lib/mysql` | Safety guard | Re-point `LAB_*` vars to lab paths |
| TCP 3306 in use | Network exposure risk | Stop non-lab listener or use isolated VM |
| Empty `COUNT(*)` after import | Wrong `.ibd` or corrupt orphan | Verify checksum and file mtime vs inventory |

## Git and data handling

- **Never commit:** `.ibd`, `.frm`, `ibdata1`, logical dumps, checksum files from production, or logs containing row-level PII.
- **Safe to commit:** runbook, DDL SQL, and guard scripts (this repository).

## V2 rule (locked)

Legacy production files → isolated recovery → logical export → clean V2 database. Recovered tablespaces are **not** attached to production runtime.
