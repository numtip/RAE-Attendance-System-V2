# Database

This directory holds **clean V2 migrations** (GitHub-first). Define schema from verified contracts; do not bind V2 runtime to the broken legacy InnoDB instance.

Do not commit dumps, backups, or row extracts from production. The current production shape is documented in `docs/CURRENT_DATABASE_SCHEMA.md` and the reuse rules are in `docs/DATABASE_REUSE_PLAN.md`.

Isolated InnoDB recovery procedures live under `database/recovery-lab/` (lab copies only; see `docs/DB_RECOVERY_LAB_REPORT.md`).
