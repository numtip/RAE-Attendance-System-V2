# Release 1 — final staging sign-off

**Gate:** `READY_FOR_VPS_APPROVAL` (GitHub-first; **no VPS deploy** until separate approval)  
**Review site:** https://numtip.github.io/RAE-Attendance-System-V2/ (fixture only)  
**Baseline `main`:** `1c2c1bc` (2026-10-01)  
**Prior readiness:** `docs/RELEASE1_STAGING_READINESS.md` — STAGING_READY

Attendance V2 uses **shared Agent Core** for optional agent decisions only; it does not host Jev/OpenRouter in this repository.

---

## 1. Final QA matrix

| Check | Result | Evidence |
|-------|--------|----------|
| Secret scan | **PASS** | CI job `secrets`; local `node scripts/secret-scan.mjs` |
| Backend lint | **PASS** | CI `backend`; local `backend` eslint |
| Backend unit tests | **PASS** | 19 pass, 3 skip (MariaDB-only without DB); CI |
| MariaDB integration | **PASS** | CI `backend-mariadb` — migrate+seed empty DB, integration tests, contract smoke |
| `contract:smoke` (fixture) | **PASS** | CI `backend`; local root script |
| `contract:smoke` (MariaDB) | **PASS** | CI `backend-mariadb` |
| `compose:smoke` | **PASS** | CI `compose-smoke` (stack up → smoke → tear down) |
| Frontend build | **PASS** | CI `frontend` |
| Pages build (fixture) | **PASS** | CI `pages-build` + GitHub Pages deploy run |
| Container build | **PASS** | CI `container` (backend + frontend images) |
| Migrations from empty DB | **PASS** | CI MariaDB service + compose `migrate` service |
| Seed + clean startup | **PASS** | `db:migrate:seed` in CI; compose one-shot migrate |
| Auth refresh / logout | **PASS** | Contract smoke + backend auth tests |
| Employee / attendance / leave happy + error paths | **PASS** | Contract smoke envelopes; MariaDB integration tests |
| Agent Core adapter (mock) | **PASS** | CI `agent-core` |
| Local Docker compose smoke | **N/A (local)** | Docker not on reviewer host; **CI authoritative** |

**QA summary:** **PASS** (all Release 1 gates green on `main` @ `1c2c1bc`; CI run [36812660861](https://github.com/numtip/RAE-Attendance-System-V2/actions/runs/36812660861)).

---

## 2. GitHub Pages review (fixture)

| Scenario | Result | Notes |
|----------|--------|-------|
| Login | **PASS** | Banner + `user@example.test` / `valid-pass` |
| Profile | **PASS** | `/profile`, Refresh control |
| Daily attendance | **PASS** | `/attendance/daily`; permission hint for standard user |
| Monthly attendance | **PASS** | `/attendance/monthly`; year/month + Load |
| Leave list | **PASS** | `/leave` |
| Leave balance | **PASS** | `/leave/balance` (nav) |
| Leave history | **PASS** | `/leave/history` (nav) |
| Responsive layout | **PASS** | Mobile-first CSS; nav + forms usable |
| Deep-link refresh | **PASS** | Direct URLs e.g. `/attendance/monthly`, `/leave` load SPA (`404.html` + base path) |
| Loading / error / empty | **PASS** | Fixture data populated; login error path via invalid credentials (UI) |
| No real backend / secrets | **PASS** | `VITE_REVIEW_MODE=fixture`; status banner on login |

**Pages summary:** **PASS**

---

## 3. Release 1 gap audit

Classification: **COMPLETE** · **BLOCKED_EXTERNAL** · **DEFERRED_RELEASE_2** · **FAIL**

| Item | Status |
|------|--------|
| Auth login / refresh / me / logout | **COMPLETE** |
| Employees list / detail / attendance history | **COMPLETE** |
| Attendance daily (admin/manager) + monthly | **COMPLETE** |
| Leave list / balance / history | **COMPLETE** |
| Health + readiness (`/health`, `/health/db`) | **COMPLETE** |
| Migrations 001–010 + dev seed | **COMPLETE** |
| MariaDB repositories + fixture mode | **COMPLETE** |
| Release 1 SPA (login, profile, attendance, leave) | **COMPLETE** |
| CI (lint, test, MariaDB, contract, compose, container, secrets, Pages) | **COMPLETE** |
| GitHub Pages fixture review | **COMPLETE** |
| Disposable compose staging stack | **COMPLETE** |
| Host nginx template + env contract | **COMPLETE** (templates in repo; not applied) |
| Production deployment runbook | **COMPLETE** (`docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md`) |
| SSO mock + gates | **COMPLETE** (dev); live MJU | **BLOCKED_EXTERNAL** |
| Legacy DB recovery on VPS | **BLOCKED_EXTERNAL** |
| Production nginx / PM2 / cutover | **BLOCKED_EXTERNAL** |
| Dashboard, reports, CSV, facescan import | **DEFERRED_RELEASE_2** |
| Legacy production data import execution | **DEFERRED_RELEASE_2** (hooks/docs only in R1) |

**FAIL items:** none for Release 1 GitHub-first scope.

**Completion estimate:** **~95%** of Release 1 product scope **COMPLETE** in repo; remaining **~5%** is **BLOCKED_EXTERNAL** (production host + live SSO + legacy DB ops), not a code gap.

---

## 4. Deployment readiness (repo only)

Prepared in repository (not executed):

- Production-oriented Docker images: `deploy/docker/backend/Dockerfile`, `deploy/docker/frontend/Dockerfile`
- Staging/reference compose: `deploy/docker-compose.yml` (+ migrate service)
- Host nginx: `deploy/nginx/rae-attendance-v2.conf.template`
- Environment contract: `.env.example`
- Migration procedure: `npm run db:migrate` / `db:migrate:seed`; `scripts/migrate.mjs`
- Health / readiness: `GET /api/v1/health`, `GET /api/v1/health/db`
- Backup / rollback / checklists: `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md`

**No deploy, SSH, or production DB changes** were performed for this sign-off.

---

## 5. Stop gate

| Question | Answer |
|----------|--------|
| CI green on `main`? | Yes |
| Pages review acceptable? | Yes (fixture) |
| Compose smoke in CI? | Yes |
| Production runbook present? | Yes |
| VPS accessed? | **No** |
| Production touched? | **No** |
| Agent Core / Jev invoked for this review? | **No** (deterministic QA + docs) |

### Verdict

**`READY_FOR_VPS_APPROVAL`**

Next step (out of scope here): human approval → VPS phase per `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md`.

---

## 6. Sign-off checklist

- [x] CI green on `main` (all jobs including `compose-smoke`)
- [x] Pages review URL loads with fixture banner
- [x] `compose:smoke` pass in CI
- [x] `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` updated
- [ ] Human VPS deployment approval (pending)
- [ ] Post-approval: execute runbook on VPS (frozen until then)
