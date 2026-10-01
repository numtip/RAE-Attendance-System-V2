# Legacy InnoDB recovery lab (isolated)

Production `attendance_db` datadir files are **recovery evidence only**. Never run these steps against the original production datadir.

## Safety

- Use a **copy** of `.frm` / `.ibd` files in a directory you control (`LAB_EVIDENCE_DIR`).
- Run MariaDB with a **separate datadir** (`LAB_DATADIR`), `--skip-networking`, and no production credentials.
- Do not commit copies, dumps, or row extracts into this repository.

## Quick start (operator)

1. Copy evidence to the lab host (rsync from a read-only snapshot).
2. Export inventory (read-only): `bash scripts/inventory-evidence.sh "$LAB_EVIDENCE_DIR"`
3. Start isolated MariaDB (example):

```bash
export LAB_DATADIR=/var/lib/mysql-recovery-lab
export LAB_SOCKET=/tmp/recovery-lab.sock
sudo mariadb-install-db --user=mysql --datadir="$LAB_DATADIR"
sudo -u mysql mysqld --datadir="$LAB_DATADIR" --socket="$LAB_SOCKET" --skip-networking &
```

4. Recreate DDL from `docs/CURRENT_DATABASE_SCHEMA.md` (or verified `.frm` exports) in database `recovery_lab`.
5. For each target table, follow `scripts/import-tablespace-workflow.sh` against **copies** only.

## Technique proof

`scripts/poc-transportable-tablespace.sh` runs a synthetic import/export cycle on the local lab socket to prove `DISCARD TABLESPACE` + `IMPORT TABLESPACE` works on this MariaDB version. It does not use production files.
