# Deploy

Nothing in this directory is applied to the legacy host without an approved cutover (**GitHub-first / VPS-last**).

| Path | Purpose |
|---|---|
| `docker/backend/Dockerfile` | CI-built API image; default `DATA_SOURCE=fixture` for smoke |
| `docker-compose.yml` | Disposable MariaDB (`3307`) and optional API profile `api` |

V2 is not deployed to production yet. When approved, the public API prefix is `/api/v1/` only. Do not reuse the legacy mix of `/api/` and `/attendance/api/`.

Local API default is `127.0.0.1:3210`. Set `HOST=0.0.0.0` only inside containers. That avoids legacy port `3000` and port `3100` on the VPS.
