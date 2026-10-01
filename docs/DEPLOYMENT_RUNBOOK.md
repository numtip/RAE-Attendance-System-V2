# Deployment runbook (V2 — not executed from this repo)

This document describes how operators prepare a **disposable** MariaDB + API + SPA stack and how to migrate schema safely. Nothing here SSHs to production or changes the legacy host without a separate approved change.

## Prerequisites

- Node.js 20+
- Docker Engine with Compose v2
- A copy of `.env` from `.env.example` (no production secrets in git)

## Local / lab stack (Docker Compose)

From the repository root:

```bash
cp .env.example .env
# Set JWT_SECRET to a long random value for anything beyond fixture smoke tests.

docker compose -f deploy/docker-compose.yml up -d --build
```

Apply schema and dev fixtures **before** first API use if MariaDB was empty or you skipped compose auto-migration:

```bash
npm ci
npm run db:migrate:seed
```

Use `MYSQL_*` env vars (defaults in `.env.example` target host port `3307` when MariaDB is published from compose).

Verify:

- `GET http://127.0.0.1:8080/api/v1/health` — API via frontend proxy
- `GET http://127.0.0.1:3210/api/v1/health/db` — database connectivity when `DB_*` is set on the backend

## Migration command (CI and operators)

| Command | Purpose |
|--------|---------|
| `npm run db:migrate` | Apply pending SQL from `database/migrations/` |
| `npm run db:migrate:seed` | Migrate then load `database/seeds/dev-fixtures.sql` (lab/dev only) |

Environment for the migrate runner:

| Variable | Default (compose host) |
|----------|-------------------------|
| `MYSQL_HOST` | `127.0.0.1` |
| `MYSQL_PORT` | `3307` |
| `MYSQL_USER` | `attendance` |
| `MYSQL_PASSWORD` | `attendance` |
| `MYSQL_DATABASE` | `attendance_v2` |

CI runs `npm run db:migrate:seed` against a service MariaDB on port `3306` with matching credentials.

## Host nginx (template only)

Render `deploy/nginx/rae-attendance-v2.conf.template` with `envsubst` (see comments in the file). Review TLS paths, `SERVER_NAME`, static root, and upstream before reload. Public API prefix remains **`/api/v1/`** only.

## Rollback notes

- **Compose lab:** `docker compose -f deploy/docker-compose.yml down` removes containers; add `-v` only if you intend to wipe the named MariaDB volume.
- **Schema rollback:** Migrations are forward-only. To undo a bad migration in lab, restore a MariaDB volume snapshot or drop/recreate the database and re-run `npm run db:migrate` (or `:seed` for dev data). Do not run destructive rollback scripts against production without DBA approval.
- **Application rollback:** V2 is not in the legacy request path until cutover. Rolling back an unreleased deploy is redeploying the previous image/tag or stopping the V2 compose stack — no legacy nginx switch is required.

## Production cutover (out of scope for this branch)

Follow `docs/MIGRATION_PLAN.md`, `docs/SSO_ACTIVATION_CHECKLIST.md`, and operator approvals before pointing production nginx at V2.
