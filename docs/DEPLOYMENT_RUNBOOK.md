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
# REQUIRED: set JWT_SECRET to a long random value. The backend refuses to start
# in production with an empty, placeholder, or <16-character secret.

npm run staging:up            # persistent: migrations only, never seeds
curl -fsS http://127.0.0.1:8080/api/v1/ready
```

This starts MariaDB, applies pending migrations (`migrate` service), then backend and frontend with readiness healthchecks.

Synthetic fixtures are **opt-in** and destructive:

```bash
npm run staging:fixture:up    # up + one-shot `seed` service
# or, against an already-running stack:
docker compose -f deploy/docker-compose.yml run --rm seed
```

`npm run db:seed` (`scripts/migrate.mjs --seed-only`) refuses to run unless all of the following hold:

| Guard | Required |
|---|---|
| `ALLOW_FIXTURE_SEED` | exactly `true` |
| `DEPLOY_ENV` | not `staging` and not `production` |
| `NODE_ENV` | not `production` |
| target host | `127.0.0.1`, `localhost`, `::1` or `mariadb` — otherwise `ALLOW_REMOTE_FIXTURE_SEED=true` |

The refusal happens before a connection is opened, so a mistyped target is never touched.

Verify Release 1 paths through the SPA proxy:

```bash
npm run compose:smoke
```

Use `MYSQL_*` env vars (defaults in `.env.example` target host port `3307` when MariaDB is published from compose).

Verify:

- `GET http://127.0.0.1:8080/api/v1/ready` — configuration and database readiness through the proxy
- `GET http://127.0.0.1:3210/api/v1/health/db` — database connectivity when `DB_*` is set on the backend

Neither route returns a host, port, credential or database name.

## Migration command (CI and operators)

| Command | Purpose |
|--------|---------|
| `npm run db:migrate` | Apply pending SQL from `database/migrations/`. Idempotent; safe on a persistent database |
| `npm run db:seed` | Load `database/seeds/dev-fixtures.sql` only. Destructive, guarded, opt-in |
| `npm run db:migrate:seed` | Migrate then seed in one run. Also guarded; dev/lab only |

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
