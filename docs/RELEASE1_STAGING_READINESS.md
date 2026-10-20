# Release 1 staging readiness

**Status:** STAGING_READY (GitHub-first — disposable MariaDB + compose + Pages review)  
**Production:** not deployed · VPS frozen · no live MJU SSO  
**Verified against:** `main` `b6b6e3d` (2026-10-19). `docs/RELEASE1_FINAL_SIGNOFF.md` cites the older baseline `1c2c1bc`; treat its test counts as historical.

Attendance V2 consumes **shared Agent Core** for optional agent decisions; it does **not** host Jev/OpenRouter.

## Feature matrix

| Feature | Status | Notes |
|---------|--------|--------|
| Regular auth (login/refresh/me/logout) | **COMPLETE** | Fixture + MariaDB |
| Employee list/detail | **COMPLETE** | No password hash in responses |
| Employee attendance history | **COMPLETE** | Ownership enforced |
| Attendance daily (admin/manager) | **COMPLETE** | User role gets 403 by contract |
| Attendance monthly summary | **COMPLETE** | Own + elevated roles |
| Leave list/balance/history | **COMPLETE** | Fixture + MariaDB seed |
| SSO routes | **PARTIAL** | Registration confirmed; the portal-mode callback returns `SSO_NOT_READY`. The merged callback also resolves identity by e-mail and does not deliver a session. Live MJU **BLOCKED_EXTERNAL** (`ac` semantics) |
| Personal attendance/leave report (`/reports/personal`, `/export`) | **COMPLETE** | PR #50; JSON report plus PDF/XLSX download |
| Dashboard / CSV / facescan import | **NOT_IN_RELEASE_1** | Legacy bundle scope |
| Legacy DB recovery execution | **BLOCKED_EXTERNAL** | Runbook only; VPS-last |
| Production nginx/PM2 cutover | **BLOCKED_EXTERNAL** | Post-approval phase |

## API matrix (`/api/v1`)

| Area | Routes | Status |
|------|--------|--------|
| Health | `GET /health`, `GET /health/db` | **COMPLETE** |
| Auth | login, refresh, me, logout | **COMPLETE** |
| Employees | list, detail, attendance | **COMPLETE** |
| Attendance | daily, monthly | **COMPLETE** |
| Leave | list, balance, history | **COMPLETE** |
| Reports | `/reports/personal`, `/reports/personal/export` | **COMPLETE** (personal report only, PR #50) |
| SSO | login, callback, me, logout | **PARTIAL** (closed until checklist) |

Contract enforcement: `npm run contract:smoke` in CI (fixture + MariaDB job).

## Database

| Item | Status |
|------|--------|
| Migrations `database/migrations/` (16 files: `001–014`, `025`, `026`) | **COMPLETE** |
| Dev seed `database/seeds/dev-fixtures.sql` | **COMPLETE** |
| CI migrate from empty DB | **COMPLETE** |
| Legacy import path | **PARTIAL** (documented hooks; no production import) |
| Production InnoDB ERROR 1932 | **BLOCKED_EXTERNAL** (not V2 runtime) |

## Frontend

| Item | Status |
|------|--------|
| Login, profile, attendance, leave pages | **COMPLETE** |
| Loading / error / empty states | **COMPLETE** |
| Responsive layout | **COMPLETE** |
| GitHub Pages fixture review | **COMPLETE** — [review site](https://numtip.github.io/RAE-Attendance-System-V2/) |
| Real API via compose/nginx | **COMPLETE** — `npm run staging:up` + `compose:smoke` |

Pages review uses `VITE_REVIEW_MODE=fixture` (no backend). Local staging uses real API proxy.

## Integration & CI

| Gate | Status |
|------|--------|
| Backend lint + unit tests | CI |
| MariaDB integration tests | CI `backend-mariadb` |
| Contract smoke | CI backend + MariaDB job |
| Compose full-stack smoke | CI `compose-smoke` |
| Frontend build + Pages build | CI |
| Container images | CI |
| Secret scan | CI |
| Agent Core adapter (mock) | CI |

## Known limitations (Release 1)

- SSO production MJU not registered — routes return `SSO_DISABLED` / `SSO_NOT_READY`.
- Daily attendance UI requires admin/manager; standard user sees permission message (by design).
- Pages review is fixture-only; not a substitute for compose staging sign-off.
- No Release 2 modules (reports, imports, dashboard aggregates).

## Security checks

- No production credentials in git; `.env.example` placeholders empty for secrets.
- JWT required for API; refresh rotation on success.
- Secret scan on every PR.
- No Agent Core/OpenRouter keys in this repository.

## Startup (local staging)

```bash
cp .env.example .env
# REQUIRED: set JWT_SECRET. Never deploy with the compose default `dev-only-change-me`.
npm run staging:up
npm run compose:smoke
npm run staging:down   # optional teardown
```

On a shared host, bind MariaDB to loopback instead of publishing `3307` on all interfaces.

Single command brings up MariaDB → migrate+seed → backend → frontend with healthchecks.

**`npm run staging:up` re-seeds on every start.** The compose `migrate` one-shot always runs `db:migrate:seed` (`deploy/docker-compose.yml:39`), and `database/seeds/dev-fixtures.sql:8-13` begins with `DELETE FROM employees / daily_attendance / monthly_summary / employee_leave / leave_balance / employee_identifier`. So every `up` **destroys employees and attendance in that MariaDB volume**. That is acceptable for a disposable smoke stack and **unacceptable for staging that must retain data**: there, run `npm run db:migrate` against the staging database instead of the compose `migrate` service. There is no migrate-only profile or override in the repository.

Compose is invoked with `-f deploy/docker-compose.yml`. Pass `--env-file .env` explicitly rather than relying on which directory Compose reads `.env` from; a silently unread `.env` falls back to `dev-only-change-me`, root/`attendance` and `SSO_ENABLED=false`.

## Staging prerequisites and blockers (verified on `b6b6e3d`)

| # | Item | Evidence | Impact |
|---|---|---|---|
| 1 | `staging:up` wipes data every start | `deploy/docker-compose.yml:39`, `database/seeds/dev-fixtures.sql:8-13` | Blocking for any staging stack that must retain data |
| 2 | `JWT_SECRET` is **not** validated at boot | `backend/src/server.js` starts without checking; `backend/src/middleware/authenticate.js:13-15` returns `503 CONFIG_ERROR` per request | Container reports healthy while every authenticated route fails |
| 3 | `/api/v1/health` checks nothing | `backend/src/api/v1/routes/health.js:9-14` returns a static payload; the compose backend healthcheck uses only this route (`deploy/docker-compose.yml:74`) | Healthchecks cannot detect a missing `JWT_SECRET`, `DATA_SOURCE=fixture`, or an unreachable DB. Use `/api/v1/health/db` as an additional gate |
| 4 | No preflight SQL on `main` | `database/preflight/` does not exist; `database/rollbacks/` holds only `025` and `026` | No schema verification before a deploy; `001`–`014` are forward-only |
| 5 | Schema gap `015`–`024` | `database/migrations/` has `001`–`014`, `025`, `026` | Staging schema cannot be claimed equal to `docs/CURRENT_DATABASE_SCHEMA.md` |
| 6 | `migrate` bind-mounts the repo root | `deploy/docker-compose.yml:29` (`..:/workspace`), and runs `npm ci` as root | A root `.env` is readable inside the container; `node_modules` is written into the host checkout |
| 7 | `CORS_ORIGIN` is dead configuration | Read in `backend/src/config/index.js:45`; no CORS middleware in `backend/src/app.js` and no `cors` dependency | Cross-origin callers fail. Fine only when the SPA is served same-origin behind nginx |
| 8 | Compose hardcodes `SSO_ENABLED: 'false'` | `deploy/docker-compose.yml:65` | SSO cannot be enabled on this stack without editing the compose file |
| 9 | Compose defaults are unsafe for a shared host | `JWT_SECRET:-dev-only-change-me`, `MARIADB_ROOT_PASSWORD:-root`, MariaDB published on `3307` | Must be overridden; see the loopback note above |
| 10 | Images run as root | `deploy/docker/backend/Dockerfile`, `deploy/docker/frontend/Dockerfile` (no `USER`) | Defence-in-depth gap, not a Release 1 blocker |
| 11 | `GET /api/v1/health/db` discloses the database name and host | `backend/src/api/v1/routes/health.js:29-33` | Unauthenticated information disclosure; low severity |
| 12 | `--dry-run` is not a ledger check | `scripts/migrate.mjs:87-91` never connects, so it lists every file as pending | Cannot be used to determine what is pending against staging |

Item 2 is why the pre-launch gate below checks `/api/v1/health/db` and performs a real login, not just container `healthy`.

## Go/no-go gate for staging

All of these must pass before the stack is handed to reviewers. Container `healthy` alone is not evidence (see blocker 2).

| Gate | Pass condition |
|---|---|
| Config assertion | `JWT_SECRET` is set to a generated value, not `dev-only-change-me`; `DATA_SOURCE=mariadb`; `NODE_ENV=production` |
| Startup | Backend does not crash; `GET /api/v1/health/db` returns `status: connected` |
| Auth | A real login on the seeded account returns tokens; `/api/v1/auth/me` returns 200 and omits `passwordHash` |
| Contract | `npm run compose:smoke` passes through the nginx proxy |
| SSO | `SSO_ENABLED=false`; `/api/v1/auth/sso/login` returns `403 SSO_DISABLED` |
| Schema | `SELECT version FROM schema_migrations ORDER BY version` matches the 16 filenames on `main`, and the `015`–`024` gap is recorded and accepted |
| Data | Staging contains synthetic fixtures only; no production data and no production database credentials |
| Secrets | `node scripts/secret-scan.mjs` passes; no `.env` in git |

## Rollback

- Compose: `npm run staging:down` (removes volumes with `-v`).
- Schema: `025` and `026` have down scripts in `database/rollbacks/`; all other migrations are forward-only, so restore a database/volume snapshot or recreate and re-migrate. Never run a destructive rollback against a real database.
- Database: re-run migrations on empty volume; no production rollback from this repo.

## External blockers (do not downgrade Release 1 dev)

| Blocker | Type |
|---------|------|
| Live MJU SSO `ac` contract (registration itself is confirmed) | **BLOCKED_EXTERNAL** |
| Legacy production DB recovery on VPS | **BLOCKED_EXTERNAL** |
| Production host nginx/PM2/cutover | **BLOCKED_EXTERNAL** |

## Sign-off checklist (staging)

- [x] CI green on `main` (all jobs including `compose-smoke`) — see `docs/RELEASE1_FINAL_SIGNOFF.md`
- [x] Pages review URL loads with fixture banner
- [x] `compose:smoke` pass in CI (local Docker optional)
- [ ] Human review of `docs/API_CONTRACT.md` vs UI (recommended before VPS)
- [ ] Approve VPS deployment phase separately — gate **`READY_FOR_VPS_APPROVAL`** in `docs/RELEASE1_FINAL_SIGNOFF.md`
