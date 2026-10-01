# Production deployment runbook (V2 — prepare only)

**Status:** Template and procedure only. **Do not execute on VPS** until explicit approval after `READY_FOR_VPS_APPROVAL` (`docs/RELEASE1_FINAL_SIGNOFF.md`).

**Policy:** GitHub-first / VPS-last · Public API prefix **`/api/v1/`** only · Do not retarget legacy `/api/` or `/attendance/api/` paths.

---

## 1. Scope

This runbook covers:

- Environment and secrets contract
- Database migration on a **new** MariaDB instance (or approved empty schema)
- Backend + frontend deployment (Docker and/or host nginx)
- Health/readiness verification
- Backup before change, rollback, and post-deploy smoke

It does **not** include legacy InnoDB recovery, live MJU SSO registration, or PM2/nginx changes on the legacy host without a separate change ticket.

---

## 2. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Approved VPS change window | Frozen until sign-off approval |
| Node.js 20+ (if running API on host) | Prefer containerized backend |
| MariaDB 11.x (InnoDB) | Dedicated DB or new schema `attendance_v2` |
| TLS certificates | For public `SERVER_NAME` |
| Secrets store | `JWT_SECRET`, DB passwords, optional SSO — **never in git** |

Copy `.env.example` to a **host-only** `.env` (or secret manager). Minimum for production API:

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | yes | `production` |
| `PORT` / `HOST` | yes | e.g. `3210`, `127.0.0.1` behind nginx |
| `DATA_SOURCE` | yes | `mariadb` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | yes | API pool |
| `JWT_SECRET` | yes | Long random value |
| `JWT_EXPIRES_IN`, `REFRESH_TOKEN_DAYS` | yes | Token policy |
| `CORS_ORIGIN` | yes | Public SPA origin (HTTPS) |
| `SSO_*` | optional | Keep `SSO_ENABLED=false` until MJU registration **COMPLETE** |

Migrate runner (operators / one-shot job) uses `MYSQL_*` (see `docs/DEPLOYMENT_RUNBOOK.md`).

Agent Core (`AGENT_CORE_*`) is optional for Attendance API runtime; configure only if agent features are enabled on the host.

---

## 3. Pre-deploy backup

1. **Database:** logical backup before first migration on production data:
   ```bash
   mysqldump -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" \
     --single-transaction --routines --triggers "$DB_NAME" \
     > "backup-attendance_v2-$(date -u +%Y%m%dT%H%M%SZ).sql"
   ```
2. **Frontend static files:** archive current `/var/www/rae-attendance-v2` (if any).
3. **Nginx:** copy active site config from `/etc/nginx/sites-available/` before edits.
4. Record **`main` git SHA** deployed and image digests (if using registry).

---

## 4. Migration procedure (empty or new DB)

From a machine with repo checkout and network to MariaDB:

```bash
export MYSQL_HOST=...
export MYSQL_PORT=3306
export MYSQL_DATABASE=attendance_v2
export MYSQL_USER=...
export MYSQL_PASSWORD=...

npm ci
npm run db:migrate
```

- **Do not** run `db:migrate:seed` in production (dev fixtures only).
- Migrations live in `database/migrations/` (001–010 for Release 1).
- For greenfield: empty DB → migrate applies all pending files in order.

**Rollback (schema):** restore from pre-migrate dump; do not run ad-hoc DDL from this repo on legacy production without DBA review.

---

## 5. Application deployment options

### Option A — Docker Compose on VPS (reference)

Use `deploy/docker-compose.yml` as a **lab reference**. For production:

- Replace default passwords and `JWT_SECRET`.
- Do not publish MariaDB to the public interface; bind to internal network only.
- Put TLS termination on host nginx in front of the frontend container **or** serve static from host (Option B).

Build and start (example — adjust paths):

```bash
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

Images are built from:

- `deploy/docker/backend/Dockerfile`
- `deploy/docker/frontend/Dockerfile` (nginx + SPA + `/api/v1/` proxy)

### Option B — Host nginx + static SPA + API upstream

1. Build frontend with production `VITE_BASE_PATH` / API base URL (not fixture mode).
2. Deploy `dist/` to `FRONTEND_ROOT` (e.g. `/var/www/rae-attendance-v2`).
3. Run backend on `127.0.0.1:3210` (systemd or container).
4. Render and install nginx config:

```bash
export SERVER_NAME=raeservice.example.ac.th
export FRONTEND_ROOT=/var/www/rae-attendance-v2
export BACKEND_UPSTREAM=http://127.0.0.1:3210
envsubst '${SERVER_NAME} ${FRONTEND_ROOT} ${BACKEND_UPSTREAM}' \
  < deploy/nginx/rae-attendance-v2.conf.template \
  > /etc/nginx/sites-available/rae-attendance-v2.conf
# Review TLS paths, enable site, nginx -t, reload
```

Template: `deploy/nginx/rae-attendance-v2.conf.template`.

---

## 6. Health and readiness

| Endpoint | Expect |
|----------|--------|
| `GET /api/v1/health` | HTTP 200, `{ "status": "ok" }` (or contract envelope) |
| `GET /api/v1/health/db` | HTTP 200 when `DATA_SOURCE=mariadb` and DB reachable |

Check from localhost before opening public traffic:

```bash
curl -sf "http://127.0.0.1:3210/api/v1/health"
curl -sf "http://127.0.0.1:3210/api/v1/health/db"
```

Through nginx (after cutover):

```bash
curl -sf "https://${SERVER_NAME}/api/v1/health"
```

Compose healthchecks mirror these paths (see `deploy/docker-compose.yml`).

---

## 7. Deployment checklist (operator)

- [ ] Approval recorded; maintenance window communicated
- [ ] Backup completed (DB + nginx + static)
- [ ] Secrets injected (JWT, DB); `.env` not committed
- [ ] `DATA_SOURCE=mariadb`, SSO disabled unless checklist complete
- [ ] Migrations applied; version logged
- [ ] Backend health + health/db pass locally
- [ ] Frontend built **without** `VITE_REVIEW_MODE=fixture`
- [ ] Nginx `nginx -t` pass; TLS valid
- [ ] CORS_ORIGIN matches public SPA URL
- [ ] Legacy routes unchanged (`/api/v1/` only for V2)

---

## 8. Post-deploy smoke checklist

Run against **production URL** (or staging host with production config):

- [ ] `GET /api/v1/health` and `/health/db`
- [ ] Login → profile (`POST /api/v1/auth/login`, `GET /api/v1/auth/me`)
- [ ] Refresh token flow (`POST /api/v1/auth/refresh`)
- [ ] Logout (`POST /api/v1/auth/logout`)
- [ ] Employee list (authorized role)
- [ ] Own monthly attendance summary
- [ ] Leave balance / history for authenticated user
- [ ] SPA deep link refresh on `/profile`, `/attendance/monthly`, `/leave`
- [ ] Optional: run `npm run contract:smoke` from CI-like runner pointed at production (read-only test accounts)

Automated reference: `scripts/contract-smoke.mjs`, `scripts/compose-smoke.mjs` (compose/lab).

---

## 9. Rollback

| Layer | Action |
|-------|--------|
| Traffic | Revert nginx site to previous config; reload nginx |
| Frontend | Restore previous static tarball to `FRONTEND_ROOT` |
| Backend | Redeploy previous container/image or git SHA |
| Database | Restore mysqldump taken in §3; **only** if migrate was destructive (avoid if forward-fix is safer) |

Document incident time, SHA rolled back to, and DB restore point.

---

## 10. Out of scope (Release 1)

- Live MJU SSO callback registration → enable only after external checklist
- Legacy VPS DB recovery (ERROR 1932 / mixed engines)
- Release 2 modules (reports, imports, dashboard)
- PM2/process manager changes on legacy Node apps

---

## 11. Related documents

| Document | Purpose |
|----------|---------|
| `docs/DEPLOYMENT_RUNBOOK.md` | Disposable compose / lab migrations |
| `docs/RELEASE1_STAGING_READINESS.md` | Feature matrix STAGING_READY |
| `docs/RELEASE1_FINAL_SIGNOFF.md` | Final QA + `READY_FOR_VPS_APPROVAL` |
| `deploy/README.md` | Artifact index |
