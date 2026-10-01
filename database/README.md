# Database

Clean **V2** schema and migrations live here (GitHub-first). They mirror `docs/CURRENT_DATABASE_SCHEMA.md` for Release 1 core tables, plus `employee_leave` shaped like `backend/src/dev/fixtures.js`. Do not commit production dumps, backups, or row extracts.

Isolated InnoDB recovery procedures remain under `database/recovery-lab/` (lab copies only).

## Layout

| Path | Purpose |
|---|---|
| `migrations/` | Ordered `.sql` files applied by `scripts/migrate.mjs` |
| `seeds/dev-fixtures.sql` | Dev rows matching `backend/src/dev/fixtures.js` |
| `recovery-lab/` | Legacy `.ibd` recovery experiments (not used by V2 runtime) |

## Run migrations (local)

1. Start disposable MariaDB:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d mariadb
   ```

2. Install root dev deps and migrate:

   ```bash
   npm install
   npm run db:migrate
   npm run db:migrate:seed
   ```

Environment variables (defaults match compose):

| Variable | Default |
|---|---|
| `MYSQL_HOST` | `127.0.0.1` |
| `MYSQL_PORT` | `3307` |
| `MYSQL_USER` | `attendance` |
| `MYSQL_PASSWORD` | `attendance` |
| `MYSQL_DATABASE` | `attendance_v2` |

Seeded login password: **`valid-pass`** (bcrypt cost 8). Regenerate hash with `npm run db:hash-dev-password` and update the seed comment/SQL if fixtures change.

## Release 1 tables

- `employees`, `employee_identifier`
- `daily_attendance`, `monthly_summary`
- `employee_leave`, `leave_balance`
- `refresh_tokens`, `auth_logs`
- `system_logs` (minimal; optional diagnostics)
- `schema_migrations` (runner bookkeeping)

Staging/import tables (`staging_leave`, facescan staging, views) are **not** in this bootstrap. They belong to a later release or legacy import hooks.

## Future legacy import hook strategy

When production InnoDB data becomes readable again, import in **layers** without binding V2 runtime to the broken legacy instance:

1. **Schema parity** — Apply this repo’s migrations to a fresh MariaDB database (empty V2 target).
2. **Logical export (preferred)** — From a recovered or lab-repaired source, `mysqldump --no-create-info` (or column-scoped `SELECT … INTO OUTFILE` / ETL) for Release 1 tables only. Map `staging_leave` rows with `match_status = 'matched'` into `employee_leave` if the app reads the fixture-shaped table first.
3. **Physical / tablespace path (lab only)** — Scripts under `database/recovery-lab/` document DISCARD/IMPORT TABLESPACE workflows. Run only on isolated copies; never against production from CI.
4. **Hook points in this repo**
   - Post-migrate SQL: add `database/migrations/NNN_legacy_import_*.sql` that are **no-op on greenfield** but document expected transforms, or
   - One-off importers: `database/import/` scripts (future) invoked manually after `npm run db:migrate`, writing into V2 tables with idempotent keys (`leave_id`, `employee_uid`, `date`, etc.).
5. **Verification** — Compare row counts and checksums per table; re-run backend tests with `DATA_SOURCE` pointed at MariaDB once the adapter is enabled.

Until import is approved, Release 1 API uses fixtures (`DATA_SOURCE=fixture`); MariaDB is for local integration only.
