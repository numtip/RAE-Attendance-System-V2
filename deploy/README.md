# Deploy

Nothing in this directory is applied to the legacy host without an approved cutover (**GitHub-first / VPS-last**).

| Path | Purpose |
|------|---------|
| `docker/backend/Dockerfile` | API image; set `DATA_SOURCE=mariadb` and `DB_*` at runtime for real data |
| `docker/frontend/Dockerfile` | Release 1 SPA on nginx; proxies `/api/v1/` to the `backend` service |
| `docker/frontend/nginx.conf` | In-container routing for compose |
| `docker-compose.yml` | Disposable stack: **mariadb**, **backend**, **frontend** |
| `nginx/rae-attendance-v2.conf.template` | Host nginx template for TLS + static + `/api/v1/` upstream |

V2 is not deployed to production yet. When approved, the public API prefix is `/api/v1/` only. Do not reuse the legacy mix of `/api/` and `/attendance/api/`.

## Quick start (compose)

From the repo root (see `docs/DEPLOYMENT_RUNBOOK.md` for migrations and rollback):

```bash
cp .env.example .env
# Set a real JWT_SECRET: the backend refuses to start on a placeholder.

# Persistent staging: migrations only, never destructive.
docker compose -f deploy/docker-compose.yml up -d --build --wait

# Disposable demo/CI only: adds synthetic fixtures via the opt-in seed service.
docker compose -f deploy/docker-compose.yml run --rm seed
```

- MariaDB: `127.0.0.1:${COMPOSE_MARIADB_PORT:-3307}` (bound to `${COMPOSE_MARIADB_BIND:-127.0.0.1}`)
- API direct: `127.0.0.1:${COMPOSE_BACKEND_PORT:-3210}` — `GET /api/v1/ready` is the readiness gate
- SPA + proxied API: `http://127.0.0.1:${COMPOSE_FRONTEND_PORT:-8080}`

Local API default outside containers is `127.0.0.1:3210`. Set `HOST=0.0.0.0` only inside containers. That avoids legacy port `3000` and port `3100` on the VPS.
