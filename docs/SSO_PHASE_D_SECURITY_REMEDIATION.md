# Phase D — SSO security remediation (development only)

Date: 2026-10-09. Host `raeserver` (`10.1.245.190`).

Development branch `phase-d/sso-security-remediation` was created in `/home/rae_admin/worktrees/RAE-Attendance-System-V2-integration` from `integration/attendance-sso-hip` at `7d810d8ac6b851b3bc3d9a4ef9b1b74bd9189929`. The branch is local only. Changes are not committed and were not pushed. Production runtime `/home/rae_admin/rae-attendance-v2-runtime` was not modified.

**MERGE NO-GO. STAGING PILOT NO-GO. PRODUCTION SSO NO-GO.**

## What changed

| Path | Change |
|---|---|
| `database/migrations/018_sso_consumed_code.sql` | New table `sso_consumed_code`. Digest primary key, TTL columns, expiry index. |
| `backend/src/services/sso/mariadbCodeReplayStore.js` | Atomic `INSERT` claim. Duplicate key is replay. Other database errors are HTTP 503. No memory fallback. |
| `backend/src/api/v1/index.js` | Uses that store only when `dataSource` is `mariadb` and a database config is present, or when a test passes `codeReplayStore`. |
| `backend/src/services/ssoService.js` | Portal `ac` claim goes to the durable store when one is configured. Session is not issued on the callback. |
| `backend/src/services/ssoIdentityResolutionService.js` | `persist: false` validates and returns. Link and refresh-token writes happen on confirm. |
| `backend/src/services/sso/ssoLoginCodeStore.js` | `peek` reads a handoff without burning it. |
| `backend/src/controllers/ssoController.js` | `POST /auth/sso/exchange` issues a session only when `confirm` is true. |
| `frontend/src/views/SsoCompleteView.vue` | Shows the candidate subject and waits for an explicit confirm. Load does not call `setSession`. |
| `backend/tests/ssoMjuTokenFlow.test.js` | Swapped `ac`, abandoned confirm, expired binding, expired handoff, durable-store fail-closed. |
| `backend/tests/ssoCodeReplayStore.test.js` | In-memory digest insert, double-use, restart, two instances, database error. |
| `backend/tests/ssoCodeReplayStore.mariadb.test.js` | Disposable MariaDB 11.4 cases. Skipped unless CI on port 3307. |
| `.github/workflows/ci.yml` | `backend-mariadb` service listens on runner port 3307. |
| `backend/tests/ssoPass9.test.js` | Awaits the now-async exchange. |
| `scripts/sso-preflight.mjs` | Residual-risk text: confirmation does not close login CSRF. |

Migration `018` sorts after `017_identifier_namespace_claim.sql`. It does not alter that file, HIP ingestion, attendance, or leave tables. It depends on the migration runner and `schema_migrations` from `001`. This commit already has two files numbered `013` and two numbered `015`; `018` does not reuse those names.

The table was not applied to any database on this host.

## QA completion (2026-10-09, still on the development branch)

Reviewed the uncommitted diff. Migration files sort `017_identifier_namespace_claim.sql` then `018_sso_consumed_code.sql`. `018` is plain `CREATE TABLE`: `CHAR(64)` `ascii_bin`, `DATETIME(3)`, InnoDB. It uses no stored function, so it does not need the `017` binary-log privilege. MariaDB 11.4 accepts that syntax. The table was not created on this host.

Portal handoff, checked in fixture tests:

| Case | Result |
|---|---|
| Single-use handoff | Second exchange is 401 |
| Expiry | Binding expires before MJU. Handoff expiry writes no refresh token |
| Browser binding | Cookie is required, single-use, and not taken from the client |
| Concurrent confirm | One 200 and one 401 |
| `confirm: false` | Preview only. No access token, link, or refresh row |
| Abandoned flow | Callback 302 writes neither link nor refresh token |
| Other portal session path | Portal callback calls `issueSessionFromOAuthProfile` with `persist: false` |

The OAuth mock path in `handleCallback` still writes the refresh token before the complete page. That path is not the portal `?ac=` flow. It remains a residual gap.

MariaDB integration file: `backend/tests/ssoCodeReplayStore.mariadb.test.js`. It connects only when `CI=true`, `RUN_MARIADB_TESTS=1`, the host is not `raeserver`, and `DB_PORT` is `3307`. On this VPS the suite is **NOT RUN**. The in-memory replay tests passed. That is not a MariaDB pass.

`.github/workflows/ci.yml` job `backend-mariadb` uses image `mariadb:11.4` and publishes it on the runner at `127.0.0.1:3307`. The job password is the existing CI fixture value. A step refuses the job when the host name is `raeserver`.

| Check | Result |
|---|---|
| ESLint `backend` on Node 20.19.5 | Pass after the integration file was included |
| Fixture SSO tests, including confirm false and concurrent confirm | Pass |
| Secret scan | Pass on tracked files. New files are still untracked |
| MariaDB 11.4 integration | **NOT RUN** |

## QA

| Check | Result |
|---|---|
| ESLint `backend` (`npm run lint`, Node 20.19.5) | Pass |
| SSO and replay tests, 107 tests | Pass. `DATA_SOURCE=fixture`. Database host variables unset. |
| Disposable MariaDB integration | **BLOCKED**. Listeners found were `127.0.0.1:3306` and unpublished project databases, including `rae-v2-mariadb`. No separate disposable server was used. `RUN_MARIADB_TESTS` was not set. |
| `node scripts/sso-preflight.mjs` with an empty environment, no `.env` | Exit 1. SSO is not enabled. Expected for this run. Production `.env` was not read. |
| `node scripts/secret-scan.mjs` | Pass on 292 tracked files. New files were still untracked at scan time; they contain no credentials. |
| Production containers | Unchanged: `rae-v2-backend` `e6bd2f5e3c87`, `rae-v2-frontend` `10cd5a0e265e`, `rae-v2-mariadb` `d22f3548f390`, `attendance-api` `4a6001ddbd8f`. Image remains `rae-attendance-v2-backend:abb2792`. |

## Residual risks

1. Explicit confirmation does not close login CSRF. MJU is not assumed to return `state`. A live browser binding still accepts an `ac` that was not issued for that login. The confirm button stops a silent session. A person who confirms still receives the session for that `ac`.
2. Binding cookies and login handoff codes stay in process memory. The MariaDB table covers `ac` replay only. A second backend process still fails a real login closed unless the proxy pins the browser, or those two stores are shared later.
3. In-memory `claimCode` remains the path when `DATA_SOURCE` is not `mariadb`. Fixture tests use that path. Restart and a second process are not covered there.
4. Migration `018` is not on the production database. `log_bin` and the live `schema_migrations` list are still UNKNOWN from Phase C2.
5. The durable store deletes only expired rows. After expiry the same digest can be claimed again. MJU single-use is still unknown.
6. OAuth mock exchange can still return tokens that were created before the complete page. The portal token flow is the path that waits for confirm before writing a refresh token.

## Not done

This development-branch commit is local only. No push, merge, deploy, restart, production migrate, production `.env` edit, or SSO flag change. MariaDB integration remains **NOT RUN** until the GitHub runner reports it.
