# Attendance V2 — local staging-readiness QA

> **Committed as evidence 2026-10-29.** Produced by a read-only QA run in an isolated clone at
> `main` = `739e6f76`. The two MariaDB containers it used were throwaway (`qa-staging-mariadb`,
> `qa-staging-mariadb-1011`, with their own disposable credentials) and were destroyed afterwards;
> no host service, production database or MJU endpoint was contacted. Findings 2 (environment-pinned
> security suites), 3 (rollback/ledger hazard) and 5 (readiness teardown hang) are each now either
> fixed or documented — see the notes inline below and `docs/SSO_STAGING_MOCK_E2E.md` §4.

# Attendance V2 — local staging-readiness QA

Repo: `numtip/RAE-Attendance-System-V2`, `main` = **739e6f76** ("docs(db): say which 015 is safe to renumber (#70)")
Clone: `/home/prinyaroot/.hermes/cache/scratch/qa-staging/repo` (isolated, disposable)
Host: Node v22.22.2, npm 10.9.7, Docker 29.7.2. No production access, no MJU contact, no host service touched.

Environment note: the pre-existing host MariaDB listens on `127.0.0.1:3306` and the live app on `:8096`.
All QA databases were containers **I created** (`qa-staging-mariadb` on 127.0.0.1:13307,
`qa-staging-mariadb-1011` on 127.0.0.1:13308) and both were destroyed at the end
(`docker rm -f -v`, `docker ps -a --filter name=qa-staging` → none, ports 13307/13308 closed).

---

## 1. Mock E2E / test suites on 739e6f76 (no database)

```bash
cd repo/backend && npm ci
node --test tests/sso*.test.js
node --test tests/*.test.js
```

| Run | tests | pass | fail | skipped |
|---|---|---|---|---|
| SSO suites (`tests/sso*.test.js`, 7 files) | **87** | **80** | **0** | **7** |
| Whole backend suite (`tests/*.test.js`, 31 files) | **232** | **218** | **0** | **14** |

Skipped-7 in the SSO run = `ssoLoginAttemptStore.mariadb` (6 DB tests) + the
"Docker/MariaDB lockout and revocation runtime" placeholder. Skipped-14 in the whole suite = the
same plus the 5 `RUN_MARIADB_TESTS`-gated tests (employee_identifier, health/db connected,
mariadb fixtures, release1 rotation) and the 2 `RUN_SECURITY_MARIADB`-gated security suites.
`npm run lint` → exit 0, no warnings.

---

## 2. Isolated MariaDB dry-run

```bash
docker run -d --name qa-staging-mariadb -p 127.0.0.1:13307:3306 \
  -e MARIADB_ROOT_PASSWORD=qa-root-only -e MARIADB_DATABASE=attendance_v2 \
  -e MARIADB_USER=attendance -e MARIADB_PASSWORD=attendance mariadb:11.4

cd repo
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=13307 MYSQL_USER=attendance \
       MYSQL_PASSWORD=attendance MYSQL_DATABASE=attendance_v2
node scripts/migrate.mjs            # run 1
node scripts/migrate.mjs            # run 2 (idempotency)
DEPLOY_ENV=test ALLOW_FIXTURE_SEED=true node scripts/migrate.mjs --seed
```

Server: `11.4.13-MariaDB-ubu2404`.

**Run 1** — exit 0, **26 files applied**, in filename order:
001,002,003,004,005,006,007,008,009,010,011,012,013,014,015_employee_identifier_secure_lookup,
015_facescan_hip_ingestion,016,017,020,021,022,023,024,025,026,028.
(No 018/019 — reserved; no 027 — absent by design. `schema_migrations` keyed on full filename.)

**Run 2** — exit 0, `apply` lines **0**, `skip` lines **26**; `SELECT COUNT(*) FROM
schema_migrations` = **26**; 28 tables present. **Idempotent: confirmed.**

Fixture seed (destructive, guarded) succeeded after migrations: `seed database/seeds/dev-fixtures.sql`.
Required because `tests/mariadb.integration.test.js` asserts on dev fixture rows
(`user@example.test` / `E-USER`).

### DB-gated suite run

```bash
cd repo/backend
export DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=attendance_v2 DB_USER=attendance DB_PASSWORD=attendance
export RUN_MARIADB_TESTS=1 RUN_SECURITY_MARIADB=1
node --test --test-force-exit tests/*.test.js
```

| tests | pass | fail | skipped |
|---|---|---|---|
| **232** | **225** | **2** | **5** |

Executed (previously skipped) and **passed**: `MariaDB employee_identifier FK and unique
constraints`; `GET /api/v1/health/db reports connected when MariaDB is configured`; `MariaDB
repositories match dev fixture data`; `Release 1 MariaDB paths: refresh rotation, employees,
monthly, leave history`; all 7 `ssoLoginAttemptStore` DB tests (028 applied, cross-process
consume, concurrent one-winner, digest-only storage, expiry+pruning, fail-closed 503, backend
capability report). Skipped-5: the three "unconfigured/not_required" assertions that invert when a
DB is configured, the `mariadb adapter is blocked` test, and the MariaDB lockout placeholder.

**2 failures** — `final MariaDB security QA` and `MariaDB security integration` — both fail on
their first assertion, before any behaviour is exercised:

```
The input did not match the regular expression /^10\.11\.14/. Input: '11.4.13-MariaDB-ubu2404'
  at tests/securitySlice.finalqa.mariadb.test.js:93
  at tests/securitySlice.mariadb.integration.test.js:30 (DB_NAME must be 'attendance_security_main_test',
      DB_HOST '127.0.0.1', DB_PORT 3306 — asserted literally)
```

Re-run in the environment they demand (`mariadb:10.11.14`, database `attendance_security_main_test`,
reachable as 127.0.0.1:3306 from a node container sharing that container's network namespace):

```bash
docker run -d --name qa-staging-mariadb-1011 -p 127.0.0.1:13308:3306 ... mariadb:10.11.14
# create attendance_security_main_test, grant, apply all 26 migrations
docker run --rm --network container:qa-staging-mariadb-1011 -v "$PWD/repo:/repo" -w /repo/backend \
  -e DB_HOST=127.0.0.1 -e DB_PORT=3306 -e DB_NAME=attendance_security_main_test \
  -e DB_USER=attendance -e DB_PASSWORD=attendance -e RUN_SECURITY_MARIADB=1 \
  -e JWT_SECRET=ci-fixture-only-secret node:22-bookworm-slim \
  node --test tests/securitySlice.mariadb.integration.test.js tests/securitySlice.finalqa.mariadb.test.js
```

**Result: 2 suites, 6 subtests = 8/8 pass, 0 fail** (migration ledger reserves 018/019; 025 rolls
down and back up; concurrent failures persist; lockout threshold/expiry/reset; **logout revocation
survives a new process**; missing revocation table fails closed).

Net: **232/232 backend tests pass, but only when the two security suites get their own
`attendance_security_main_test` database on MariaDB 10.11.14.** On the repo's own pinned
`mariadb:11.4` (compose + CI service) those two suites can never pass.

### Finding: the DB-mode suite hangs without `--test-force-exit`

```
node --test tests/*.test.js   # DB configured
# ... 114 results, then nothing. Killed at 420 s.
node --test tests/readiness.test.js   # DB configured, timeout 40
ok 1..4  →  exit 124 (process never exits)
```

`readiness.test.js` hits `/api/v1/health/db` with a live DB, which opens the shared mysql pool, and
never calls `closePool()`. The child process keeps the handle and `node --test` waits forever. With
no DB configured the pool is never created, which is why the default local run looks clean. CI
already uses `--test-force-exit`; a local run without it appears to hang. Assertions are fine, the
teardown is missing.

---

## 3. Rollback validation (same throwaway server, disposable database)

Drilled against a fresh `attendance_rb`/`rb2`/`rb3` database created inside my container and dropped
afterwards: migrate → apply `<name>.down.sql` → apply it a second time → clear the ledger row →
migrate again (re-apply the up file).

| rollback | tables before → after | 2nd run | re-apply up |
|---|---|---|---|
| 015_employee_identifier_secure_lookup | 28 → 27 | rc=0 | applies 1 (file deletes its own ledger row) |
| 017_identifier_namespace_claim | 28 → 27 | rc=0 | applies 1 |
| 020_employee_assignment_effective_dating | 28 → 27 | rc=0 | applies 1 |
| 021_facescan_ingestion_provenance | 28 → 28 (columns only) | rc=0 | applies 1 |
| 022_attendance_rule_versioning | 28 → 25 (3 tables) | rc=0 | applies 1 |
| 023_daily_attendance_provenance | 28 → 27 | rc=0 | applies 1 |
| 024_monthly_summary_provenance | 28 → 28 (columns only) | rc=0 | applies 1 |
| 025_revoked_access_tokens | 28 → 27 | rc=0 | applies 1 |
| **026_refresh_token_family** | 28 → 28 (columns/indexes) | **rc=1** | applies 1 |
| 028_sso_login_attempt | 28 → 27 | rc=0 | applies 1 |

### 028_sso_login_attempt (the SSO attempt store)

```
before:           sso_login_attempt exists = 1 ; ledger rows for 028 = 1 ; 1 row inserted
after .down.sql:  sso_login_attempt exists = 0 ; ledger rows for 028 = 1   <- ledger NOT updated
plain migrate:    skip 028_sso_login_attempt.sql   (table stays missing)
delete ledger row, migrate: apply 028_sso_login_attempt.sql
after re-apply:   sso_login_attempt exists = 1 ; rows = 0 (attempts are intentionally lost)
```

Safe to rerun (DROP TABLE IF EXISTS). But a rollback leaves the ledger claiming the migration is
applied, so a plain `npm run db:migrate` will **not** restore the table — only 015 deletes its own
ledger row (`DELETE FROM schema_migrations WHERE version = '015_...'`); the other nine do not. An
operator must clear the ledger row by hand. That is the real rollback hazard here, not the DDL.

### 026_refresh_token_family — the one rollback that is NOT safe to rerun

```
rows before (1 pre-026 plaintext + 1 post-026 hashed): 2   (hashed rows = 1)
after .down.sql:                                       1   (the post-026 session was DELETED)
2nd run: ERROR 1091 (42000) at line 8: Can't DROP INDEX `idx_refresh_tokens_family_id`;
         check that it exists
re-apply up after ledger reset: applies, 3 columns back, ledger 26
```

Two problems, both intentional-looking but undocumented in the rollback file's header:
1. `DELETE FROM refresh_tokens WHERE token IS NULL` irreversibly drops every post-026 session
   (rows whose plaintext token was already discarded). Those users must sign in again.
2. The `DROP INDEX` statements carry no `IF EXISTS` guard, so a second run aborts with 1091 —
   unlike 021/024, which guard every object with `information_schema` checks. Re-running it is not
   idempotent; partial reversal followed by a retry leaves the table in a half-rolled-back state.

---

## 4. Behaviour QA (mock provider, no MJU)

Command: `cd backend && node --test tests/authorization.test.js tests/securitySliceLockoutRevocation.test.js tests/sso*.test.js`
→ **102 tests, 94 pass, 0 fail, 8 skipped** (the 8 are the DB-gated attempt-store/harness ones;
they passed in the DB run above).

| Area | Verdict | Evidence (test name → observed) |
|---|---|---|
| Approved link — **absent** | PASS | `contract: a confirmed subject contract does not bypass the approved-link gate` → `IDENTITY_UNKNOWN`; `contract: live callback never issues a session from a profile e-mail` → `SSO_SUBJECT_INVALID` / `email_only`, `saves.count === 0` |
| Approved link — **pending** | PASS | `contract: a pending identity link is refused` → `IDENTITY_NOT_APPROVED`; service level `candidate link is denied at session issuance` |
| Approved link — **approved** | PASS | `contract: live callback issues tokens only through an approved identity link` → session for `LINKED_EMPLOYEE_UID`; `approved identity link issues session when subject is verified`; revoked link → denied (`revoked link is denied at session issuance`); disabled employee → denied |
| Approved link — **stale e-mail evidence** | PASS | `contract: an approved link whose e-mail evidence no longer matches is rejected` → `IDENTITY_EMAIL_MISMATCH` |
| CSRF / signout — POST-only | PASS | route table: `router.post('/auth/logout', authenticate, …)`, no GET route. Live probe of the fixture app: `GET /api/v1/auth/logout -> 404 NOT_FOUND`, `POST /api/v1/auth/logout -> 401 UNAUTHORIZED`, `POST /api/v1/auth/sso/logout -> 401` |
| CSRF / signout — gate closed | PASS | probe `GET /api/v1/auth/sso/signout -> 403 SSO_DISABLED`, `GET /api/v1/auth/sso/login -> 403 SSO_DISABLED`; tests `the unauthenticated signout endpoint stays closed while SSO is disabled`, `SSO HTTP routes stay closed by default`, plus 5 signout-URL/cookie tests (cid exactly once, no sample client id, https+credential-free, open-redirect rejected) |
| State / replay — replayed callback | PASS | `contract: SSO_STATE_INVALID for missing, wrong, or reused state`; store-level `a state is single use`, `an expired state is refused even on first presentation`; DB-mode `an attempt created in one process is consumed by another`, `concurrent consumers of one attempt: exactly one wins`, `expired attempts are refused and pruned` |
| State / replay — missing or tampered binding cookie | PASS | `a callback without the binding cookie is refused even with a valid state`; `a tampered or malformed cookie value is treated as absent`; `a missing binding on a bound attempt is refused`; `a wrong binding both fails and destroys the attempt`; `a state created without a binding is not satisfied by presenting one`; `a client-supplied binding cookie is ignored at login (fixation defence)` |
| Session — rotation | PASS | fixture `contract: mock provider success flow (login, callback, me, logout)`; DB-mode `Release 1 MariaDB paths: refresh rotation, …` (ok in DB run) and `logout revocation survives a new process and a second process` |
| Session — revocation on logout | PASS | `logout revokes the access token, replay stays revoked, and a second instance sees it after restart` (ok 9); DB-mode `logout revocation survives a new process and a second process` (ok 5 of the security suite); `a missing revocation table fails closed`; `logout clears the pending login attempt as well as ending the session` |
| Authorization — plain user cannot read another employee's data | PASS | `EMPLOYEE sees only self and cannot switch employee_id` (service level) and `employees, attendance, and leave enforce ownership` (HTTP 403 at `/employees/:uid/attendance`, `/attendance/monthly/:uid`, `/leave/history/:uid`); MANAGER/EXECUTIVE/ADMIN scoping tests also pass |

Authorization quote — `backend/tests/authorization.test.js`:

```js
test('EMPLOYEE sees only self and cannot switch employee_id', async () => {
  const api = withScope([], []);
  const auth = { role: 'EMPLOYEE', employeeUid: userUid };
  const list = await api.employees.list(auth);
  assert.deepEqual(list.map((row) => row.employeeUid), [userUid]);
  await assert.rejects(
    () => api.employees.getByUid(auth, adminUid),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );
  ...
  await assert.rejects(
    () => api.attendance.monthly(auth, otherUid, 2026, 3),
    (err) => err.status === 403,
  );
```

---

## 5. Findings that affect staging readiness

1. **`readiness.test.js` leaks the mysql pool** → any DB-configured `node --test tests/*.test.js`
   hangs after 114 results. Needs `closePool()` in that file (or `--test-force-exit` everywhere).
2. **The two security suites are dead in CI.** `.github/workflows/ci.yml › backend-mariadb` sets
   `RUN_MARIADB_TESTS=1` but never `RUN_SECURITY_MARIADB`, never creates
   `attendance_security_main_test`, and pins `mariadb:11.4` while the tests assert
   `/^10\.11\.14/`. So 2 suites (8 assertions incl. logout-revocation-across-processes) skip in CI
   and, if forced, fail on the version pin. They pass only on 10.11.14 in a DB of that exact name.
3. **`026` rollback is not rerunnable** (raw `DROP INDEX`, no `IF EXISTS`) and deletes every
   post-026 refresh-token row irreversibly.
4. **Rollbacks do not update the migration ledger** (except 015): after a rollback,
   `npm run db:migrate` skips the file and the schema stays partially rolled back.
5. `docs/SSO_STAGING_MOCK_E2E.md` §2 lists 6 SSO suites; `tests/ssoSignout.test.js` (16 signout
   tests) is missing from the documented command, so the doc's own coverage claim understates it.
6. Minor: `scripts/migrate.mjs` prints a plain filename order; two `015_` files coexist (both
   applied, both ledgered) — harmless but confusing in migration listings.

## 6. Not verifiable without MJU / a real IdP

- Anything about MJU behaviour: real `/signin.aspx` / `/signout.aspx` parameter semantics, whether
  `cid` stays stable, whether the callback URL must be pre-registered, whether `state` is echoed.
- Real token-endpoint and userinfo contracts: claim names/values, `sub` stability, e-mail claim
  drift, error shapes, timeouts and rate limits (the mock is refused under `NODE_ENV=production`,
  correctly).
- The live "subject contract confirmed" flip (`SSO_CALLBACK_CONFIRMED`/`subjectContractConfirmed`)
  and therefore any real approved-link mapping decision for actual people.
- Deployed-container fail-closed probe of the compose stack: **not run**. `docker compose -f
  deploy/docker-compose.yml up` would build the backend/frontend images and publish 3210/8080 next
  to the existing host services; only the plain MariaDB container path was used.
- `npm run contract:smoke` (needs a DB + `DATA_SOURCE=mariadb`) and the frontend: **not run**, out
  of the requested scope.

## 7. Reproduce

```bash
git clone https://github.com/numtip/RAE-Attendance-System-V2.git && cd RAE-Attendance-System-V2
git checkout 739e6f76
cd backend && npm ci && node --test tests/sso*.test.js && node --test tests/*.test.js
# DB: see section 2 (container 13307, migrate ×2, --seed, RUN_MARIADB_TESTS=1 RUN_SECURITY_MARIADB=1
#     with --test-force-exit; security suites need 10.11.14 + attendance_security_main_test)
# rollbacks: section 3; behaviour probe: section 4
docker rm -f -v qa-staging-mariadb qa-staging-mariadb-1011
```

Artifacts (logs): `qa-staging/baseline.log`, `sso-baseline.log`, `migrate-1.log`, `migrate-2.log`,
`seed.log`, `readiness-hang.log`, `db-run-3.log`, `security-db.log`, `security-db-1011.log`,
`rollbacks.log`, `rollback-focus.log`, `behaviour.log`.
