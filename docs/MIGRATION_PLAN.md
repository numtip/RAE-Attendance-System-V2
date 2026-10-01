# Migration plan

Legacy forensic recovery is stopped. Further inspection of the legacy tree happens only if a new backup or source tree appears.

## Now

1. Keep this repository as the canonical V2 codebase (**GitHub-first / VPS-last** — see `PROJECT_DIRECTION.md`).
2. Leave the legacy host, nginx, PM2, Docker attendance image, and production database unchanged until an approved cutover.
3. Implement Release 1 against `/api/v1` using the contract in `API_CONTRACT.md`.
4. Treat legacy production database files as **recovery evidence only**. Any restore path goes through an isolated lab and a logical export into a clean V2 database (`docs/DB_RECOVERY_LAB_REPORT.md`, operator steps in `docs/DB_RECOVERY_EXECUTION_RUNBOOK.md`).
5. Prepare SSO activation using `docs/SSO_ACTIVATION_CHECKLIST.md` — keep `SSO_ENABLED=false` until MJU confirms the V2 callback and endpoint URLs.

## Before any production cutover

1. Resolve `ERROR 1932` on `attendance_db.employees` under a separate approval. Until the table opens, V2 cannot read production rows.
2. Add a least-privilege database user for V2. Do not reuse a copied password file in git.
3. Register the SSO callback (`https://raeservice.mju.ac.th/api/v1/auth/sso/callback`) and complete `docs/SSO_ACTIVATION_CHECKLIST.md`.
4. Point a new frontend build at `/api/v1` only.
5. Add an nginx location for `/api/v1/` in a reviewed change. Do not retarget the legacy `/api/` location as part of this bootstrap.
6. Run Release 1 routes against a copy or a read-only window before any write to `auth_logs` or `refresh_tokens`.

## Out of the first cutover

Dashboard summary, plural report routes, admin CSV, file upload, and facescan-daily import. They stay retired until their handlers are specified from the production bundle and a schema that can be queried.

## Rollback

V2 is not in the legacy request path. Rolling back this bootstrap is deleting or ignoring the branch. There is no production switch to undo.
