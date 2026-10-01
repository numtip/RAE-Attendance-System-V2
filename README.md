# RAE Attendance System V2

Rebuild of the RAE attendance API and Vue client from verified contracts and the existing production schema.

Canonical repository: https://github.com/numtip/RAE-Attendance-System-V2

## Development policy

**GitHub-first / VPS-last** — build and test in this repo and CI. VPS `10.1.245.190` is for approved recovery, production validation, live SSO QA, and cutover only. See `docs/PROJECT_DIRECTION.md`.

Legacy forensic recovery has stopped. The legacy host is left unchanged.

## Layout

- `backend/` Node.js API under `/api/v1/`
- `frontend/` Vue 3 + Vite + TypeScript shell
- `database/` future migrations; `database/recovery-lab/` isolated InnoDB recovery scripts (lab copies only)
- `agent/` shared Agent Core adapter (agent-only — not HTTP API)
- `docs/` direction, contract, schema, migration, recovery runbook, SSO, and agent policy

## Local checks

Use Node.js 20 or newer.

```bash
cd backend && npm ci && npm test && npm run lint
cd agent && npm test
cd frontend && npm ci && npm run build
node scripts/secret-scan.mjs
docker build -f deploy/docker/backend/Dockerfile .
```

CI runs the same gates on every pull request (including container build).

Release 1 core routes are implemented against fixture data by default (`DATA_SOURCE=fixture`). Production MariaDB stays blocked while `ERROR 1932` stands.

## Recovery and SSO (pre-production)

| Track | Doc |
|---|---|
| DB recovery lab report | `docs/DB_RECOVERY_LAB_REPORT.md` |
| Operator runbook (host `10.1.245.190`, copy-only) | `docs/DB_RECOVERY_EXECUTION_RUNBOOK.md` |
| SSO readiness | `docs/SSO_READINESS.md` |
| SSO activation checklist | `docs/SSO_ACTIVATION_CHECKLIST.md` |

Legacy production database files are **evidence only** — not the V2 runtime. SSO stays **`SSO_ENABLED=false`** until MJU callback registration is confirmed.

## Status

This repository does not deploy V2, does not start legacy services, and does not write the production database.
