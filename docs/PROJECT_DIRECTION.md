# Project direction

RAE Attendance System V2 is a rebuild. Legacy forensic recovery is stopped.

Canonical repository: https://github.com/numtip/RAE-Attendance-System-V2

The legacy host `10.1.245.190` stays as it is. V2 is built from:

- the production Vue bundle contract at `/var/www/attendance-dashboard/dist/`
- the December 2025 Docker image `docker-raeserver-attendance-api:latest` as a source donor, not as a runtime
- production schema metadata that could be read without writing the database

The public API namespace is `/api/v1/`. V2 does not recreate the legacy split between `/api/` and `/attendance/api/`.

Release 1 is a foundation: health, regular login, refresh, current user, SSO login/callback/me/logout, employee profile/lookup, attendance daily/monthly, and leave list/balance/history. It does not implement the full legacy surface of 57 frontend calls.

This repository does not deploy V2 and does not change nginx, PM2, or the production database.

## Development policy: GitHub-first / VPS-last

**Default:** All V2 development happens in GitHub, cloud agent workspaces, and CI — not on the VPS.

| Where | Use for |
|---|---|
| **GitHub / CI / workspace** | Release 1 completion, frontend, `/api/v1`, auth/JWT, SSO mock/provider, employee/attendance/leave, clean V2 schema and migrations, fixtures, Docker build, deployment templates, tests, security scans, docs |
| **VPS `10.1.245.190` (last stage only)** | (1) Legacy evidence / DB recovery **after approval**, (2) production-specific validation CI cannot reproduce, (3) live MJU SSO QA after callback and URLs are confirmed, (4) final deployment / cutover |

**Do not** use the VPS as the primary development workspace. **Do not** SSH or run VPS operations unless GitHub/CI cannot do the work and the task fits the four VPS uses above.

### VPS gate (before any VPS access)

Document in the PR or run log:

1. **Why VPS is required** — what CI/workspace cannot do.
2. **Read-only or write** — expected side effects.
3. **What will change** — files, services, database (production changes need explicit approval).

Recovery scripts and runbooks live in this repo; **execution** on `10.1.245.190` is operator-led and copy-only (`docs/DB_RECOVERY_EXECUTION_RUNBOOK.md`).

### Database strategy (GitHub path)

- Design and migrate a **clean V2 schema** from verified contracts (`docs/CURRENT_DATABASE_SCHEMA.md`, `docs/API_CONTRACT.md`).
- Use **`DATA_SOURCE=fixture`** and disposable test DB/containers in dev/CI — not production MariaDB.
- Legacy recovered data (future): `legacy → isolated recovery → logical export → validation → V2 DB`.
- **No** runtime dependency on the broken legacy InnoDB instance.

### SSO strategy (GitHub path)

- Implement and QA with **`SSO_PROVIDER=mock`** and contract tests in CI.
- Live MJU calls only on VPS/production **after** callback registration, endpoint URL confirmation, and secrets in env (`docs/SSO_ACTIVATION_CHECKLIST.md`). Keep **`SSO_ENABLED=false`** until then.

### CI gates (every PR)

- Backend lint and tests (including boot/contract)
- Frontend build
- Secret scan
- Backend container image build (`deploy/docker/backend/Dockerfile`)

## Legacy database runtime decision

Legacy production database files are **recovery evidence and a data source only**, not the future runtime database.

If recovery succeeds, the path is:

`legacy files → isolated recovery lab → logical export → clean V2 database`

Do not revive the broken production InnoDB instance as the V2 runtime.

Operator execution (copy-only, isolated lab, VPS-last): `docs/DB_RECOVERY_EXECUTION_RUNBOOK.md`.

## SSO

V2 SSO routes live under `/api/v1/auth/sso/*`. Implementation is testable with a mock provider; **production MJU calls stay off** until `SSO_CALLBACK_CONFIRMED=true` and the checklist in `docs/SSO_ACTIVATION_CHECKLIST.md` is complete. Proposed production callback: `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`.
