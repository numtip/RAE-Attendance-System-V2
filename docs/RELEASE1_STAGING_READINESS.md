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
# REQUIRED: set JWT_SECRET. The backend now refuses to start with the compose
# placeholder `dev-only-change-me` or with a secret shorter than 16 characters.

npm run staging:up          # persistent: migrations only, no seed
curl -fsS http://127.0.0.1:8080/api/v1/ready

npm run staging:fixture:up  # disposable demo/smoke: migrations + synthetic fixtures
npm run compose:smoke
npm run staging:down        # optional teardown (destroys the volume)
```

On a shared host, keep `COMPOSE_MARIADB_BIND=127.0.0.1` (the default) so the database is not published on all interfaces.

Healthchecks are readiness-based: the backend container is only `healthy` when `/api/v1/ready` reports a valid configuration and a reachable database.

Compose is invoked with `-f deploy/docker-compose.yml`. Pass `--env-file .env` explicitly rather than relying on which directory Compose reads `.env` from; a silently unread `.env` leaves `JWT_SECRET` at the placeholder, which now stops the backend at boot instead of serving with a known secret.

## Staging prerequisites and blockers (verified on `b6b6e3d`)

| # | Item | Evidence | Impact |
|---|---|---|---|
| 1 | `staging:up` wiped data every start (compose `migrate` always ran `db:migrate:seed`) | **FIXED** — `migrate` runs `db:migrate` only; the destructive seed is a separate opt-in `seed` service (`profiles: [fixture-seed]`) invoked by `npm run staging:fixture:up` or `docker compose … run --rm seed` |
| 2 | `JWT_SECRET` was **not** validated at boot | **FIXED** — `assertRuntimeConfig()` runs in `start()` before `listen()`; production refuses an empty, placeholder or `<16`-character secret and exits non-zero |
| 3 | `/api/v1/health` checks nothing and was the compose healthcheck | **FIXED** — `/api/v1/ready` is the healthcheck and reports configuration plus database reachability |
| 4 | No preflight SQL on `main` | **OPEN** — `database/preflight/` still does not exist; `001`–`014` stay forward-only |
| 5 | Schema gap `015`–`024` | **OPEN / REPORTED, not invented** — 16 migration files: `001`–`014`, `025`, `026`. No migration was created to fill the gap |
| 6 | `migrate` bind-mounts the repo root and runs `npm ci` as root | **OPEN** — unchanged; pass an explicit `--env-file` and keep credentials out of a root `.env` the mount would expose |
| 7 | `CORS_ORIGIN` is dead configuration | **OPEN** — no CORS middleware; the SPA must be same-origin behind nginx |
| 8 | Compose hardcodes `SSO_ENABLED: 'false'` | **OPEN by design** — SSO stays off; enabling it needs the SSO activation gate, not this change |
| 9 | Compose defaults unsafe on a shared host | **FIXED** — MariaDB binds to `${COMPOSE_MARIADB_BIND:-127.0.0.1}`; a placeholder `JWT_SECRET` now stops the backend at boot instead of serving traffic |
| 10 | Images ran as root | **FIXED** — backend `USER node`; frontend uses `nginxinc/nginx-unprivileged` (UID 101) |
| 11 | `GET /api/v1/health/db` disclosed the database name and host | **FIXED** — both removed; driver errors are no longer echoed |
| 12 | `--dry-run` is not a ledger check | **OPEN** — it still lists every file; use the real runner to see `skip`/`apply` |

## Persistent staging procedure (synthetic data only)

Persistent staging means the database survives a restart, so it uses **migrations only**.

```bash
# 1. Configuration (outside git): DEPLOY_ENV=staging, a generated JWT_SECRET
#    (>= 16 chars, not a repo placeholder), ALLOW_FIXTURE_SEED=false.

# 2. Schema only. Idempotent, never destructive.
npm run staging:up

# 3. Prove readiness through the proxy
curl -fsS http://127.0.0.1:8080/api/v1/ready

# 4. Restart and confirm nothing was lost or reseeded
docker compose -f deploy/docker-compose.yml restart mariadb backend frontend
curl -fsS http://127.0.0.1:8080/api/v1/ready
```

A disposable fixture stack remains available for demos and the CI smoke: `npm run staging:fixture:up`.

**Do not run `db:seed` against persistent staging.** The guard refuses it before opening a connection:

| Condition | Result |
|---|---|
| `DEPLOY_ENV=staging` or `production` | refused |
| `NODE_ENV=production` | refused |
| `ALLOW_FIXTURE_SEED` is not exactly `true` | refused |
| host is not `127.0.0.1`, `localhost`, `::1` or `mariadb`, and `ALLOW_REMOTE_FIXTURE_SEED` is not `true` | refused |

A refused seed exits `1` and states that no connection was opened and no data changed. A permitted run prints the exact tables it will clear.

## Go/no-go gate for staging

All of these must pass before the stack is handed to reviewers. Container `healthy` alone is not evidence (see blocker 2).

| Gate | Pass condition |
|---|---|
| Config assertion | `JWT_SECRET` is a generated value, not a placeholder; `DATA_SOURCE=mariadb`; `NODE_ENV=production` |
| Startup | Backend starts (it now refuses to listen on invalid configuration); `GET /api/v1/ready` returns `status: ready` |
| Readiness disclosure | `/api/v1/ready` and `/api/v1/health/db` return no host, port, credential, driver or database name |
| Auth | A real login returns tokens; `/api/v1/auth/me` returns 200 and omits `passwordHash` |
| Contract | `npm run compose:smoke` passes through the nginx proxy, before **and** after a restart |
| SSO | `SSO_ENABLED=false`; `/api/v1/auth/sso/login` returns `403 SSO_DISABLED` |
| Schema | `SELECT version FROM schema_migrations ORDER BY version` matches the 16 filenames, and the `015`–`024` gap is recorded and accepted |
| Seed guard | `db:seed` refuses with `DEPLOY_ENV=staging` (exit 1, no connection opened) |
| Data | Synthetic fixtures only; no production data and no production database credentials |
| Secrets | `node scripts/secret-scan.mjs` passes; no `.env` in git |

## Rollback

- **Application (no schema change):** `docker compose -f deploy/docker-compose.yml up -d` on the previous image/tag, or restart the service. V2 is not in the legacy request path.
- **Compose teardown:** `npm run staging:down` (removes containers; `-v` also removes the MariaDB volume). Losing the volume is acceptable for staging because it holds synthetic fixtures only — never run it against anything else.
- **Schema:** `025` and `026` ship down scripts in `database/rollbacks/`. `001`–`014` are forward-only: restore a database or volume snapshot, or recreate and re-migrate. Never run a destructive rollback against a real database.
- **Bad seed on staging:** not possible through the supported path — `db:seed` refuses `DEPLOY_ENV=staging`. If someone forced it, restore the snapshot taken before the seed.

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
