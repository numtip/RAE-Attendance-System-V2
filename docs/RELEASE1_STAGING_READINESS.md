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
