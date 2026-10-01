# RAE Attendance System V2

Rebuild of the RAE attendance API and Vue client from verified contracts and the existing production schema.

Canonical repository: https://github.com/numtip/RAE-Attendance-System-V2

Legacy forensic recovery has stopped. The legacy host is left unchanged.

## Layout

- `backend/` Node.js API under `/api/v1/`
- `frontend/` Vue 3 + Vite + TypeScript shell
- `database/` future migrations only
- `docs/` direction, contract, schema, and migration plans

## Local checks

Use Node.js 20 or newer.

```bash
cd backend && npm ci && npm test && npm run lint
cd frontend && npm ci && npm run build
node scripts/secret-scan.mjs
```

`GET /api/v1/health` is implemented. The other Release 1 routes answer `501 NOT_IMPLEMENTED` until the next phase.

## Status

This bootstrap does not deploy, does not start legacy services, and does not write the production database.
