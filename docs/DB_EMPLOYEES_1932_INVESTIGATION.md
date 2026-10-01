# ERROR 1932 investigation

Date: 2026-10-01. Read-only. No repair, drop, alter, create, or write was run.

## Result

`employees` is not a single broken table. Every base table in `attendance_db` fails the same way, and both views fail because they reference `employees`.

Root cause: **PROVEN**.

On 2026-06-02 05:02 the InnoDB system tablespace was reinitialized. The per-table `.frm` and `.ibd` files were left in place, so MariaDB still lists the tables but the engine has no dictionary entry for them.

## Evidence

| Check | Result |
|---|---|
| `information_schema.TABLES` | `employees` is `BASE TABLE`. `ENGINE` is null. Comment is `Table 'attendance_db.employees' doesn't exist in engine`. The same comment is on every base table. |
| `SHOW COLUMNS FROM employees` | `ERROR 1932 (42S02)`. |
| Views | `vw_attendance_daily` and `vw_monthly_report` exist. Opening them returns 1932 for `employees`. |
| Foreign keys | `information_schema.INNODB_SYS_FOREIGN` has no rows. No engine FK depends on `employees`. |
| Files | `employees.frm` (11,139 bytes, mtime 2026-01-15) and `employees.ibd` (229,376 bytes, mtime 2026-02-09) are present. `innodb_file_per_table` is ON. |
| System tablespace | `ibdata1` is 12,582,912 bytes with mtime 2026-06-02 05:02. |
| InnoDB dictionary | `INNODB_SYS_TABLES` contains only `SYS_FOREIGN`, `SYS_FOREIGN_COLS`, and `SYS_VIRTUAL`. Count of `attendance_db/%` entries is 0. |
| Startup log | 2026-06-02 05:02, 2026-06-12, and 2026-08-18: InnoDB starts near LSN 13571 with transaction id 4, and `mysql.gtid_slave_pos` also returns 1932. |
| Other employee table | The only names are `employees` and `employee_identifier`. Both are unreadable. `research_projects_old_20251225` is unreadable too. |
| Logical backup | `real-attendance-system/database/backup/attendance_db_backup_20251125_024132.sql` is 12,608 bytes, 8 `CREATE TABLE` statements and 4 `INSERT` statements. It is not a full data backup. It was not copied into this repo. |

A 12 MiB `ibdata1` with transaction id 4 is a new InnoDB instance. The `.ibd` files are older than that file. They are orphaned tablespaces.

## Data risk

Unreadability is proven. Destruction of the row bytes is not proven: `employees.ibd` and the other `.ibd` files are still on disk, including a 20 MiB `staging_facescan_daily.ibd`.

The risk of making that worse is high if someone drops the schema or replaces `ibdata1` again. Leave the files untouched until a copy-based recovery is approved.

## Recovery options, not executed

1. Copy the datadir aside, then try MariaDB transportable tablespace import (`ALTER TABLE ... IMPORT TABLESPACE`) against a recreated DDL on that copy. Confirm row counts before any production change.
2. Restore from a logical dump taken after 2026-02-09 if one is found. The November 2025 file in the legacy tree is too small to be that dump.
3. Keep V2 on the fixture repository until a recovered copy can be queried. Do not create a replacement production table to hide this error.

## V2 consequence

Repositories talk to an interface. `DATA_SOURCE=fixture` is the default and is what tests use. `DATA_SOURCE=mariadb` is implemented as a blocked adapter: it does not open a connection and returns `DB_UNAVAILABLE`. There is no production-credential test and no fake production table.
