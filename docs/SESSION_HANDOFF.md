# Session Handoff

Last updated: 2026-10-09 (after PR #34 was opened). Read this file **before** starting any work.
It contains no PII, secrets or real CSV content, and must stay that way.

## 1. Repo and working branch

* Single workspace: `G:\ProjectAI\rae-attendance-system-v2` (GitHub: `numtip/RAE-Attendance-System-V2`).
* Working branch: **`integration/attendance-sso-hip`** (tracks `origin/integration/attendance-sso-hip`).
* There are no extra Git worktrees. The former worktrees (`rae-pr30-work`, `rae-secure-id`, `rae-sso-integration`) were removed through `git worktree remove` after all their commits were confirmed reachable. Do not create new worktrees or project folders.
* Do not use `git add -A`: the CSV and `database/local/` are only protected by `.gitignore`.
* Preserved local safety nets (never delete without explicit approval):
  * `stash@{0}` = Main's old uncommitted work from before the integration (also copied to `G:\ProjectAI\_backups\main-uncommitted-20261009`, with patch and SHA256SUMS).
  * `stash@{1}` = unrelated older `wip release1 frontend`.

## 2. GitHub status

| Item | State |
|---|---|
| PR #30 `docs/mju-subject-evidence-pack` (head `0a5e492`) | OPEN, not merged, base `main` |
| PR #33 `feat/facescan-ingestion-phase-a` (head `00b92c5`) | OPEN, not merged, base `main` |
| PR #34 `integration/attendance-sso-hip` (head `2feb554` on origin) | **Draft**, OPEN, base `docs/mju-subject-evidence-pack`; CI 8/8 green; keep Draft |
| `origin/main` | `3244553` |

* Pushed: `integration/attendance-sso-hip` (fast-forward only, no force) up to `2feb554` (docs only; fast-forward). Commits made after that stay local until the user approves a push. Nothing has been merged. Commits made after that stay local until the user approves a push.
* PR #34 range = 5 own commits + 2 FaceScan commits (the same ones as PR #33) + 1 merge commit + docs commits. Merge order: **#30 -> #33 -> #34**.

### Merge readiness (reviewed 2026-10-09)

| PR | CI | Mergeable | Depends on | Verdict |
|---|---|---|---|---|
| #30 | 8/8 green | clean | main | Ready technically. Touches `.gitignore`, which #33 also touches. |
| #33 | 8/8 green | clean vs main today | main (independent of #30) | Ready technically **but** after #30 merges it conflicts with main on `.gitignore` (proven with `git merge-tree 0a5e492 00b92c5`). #33 needs a small update before merging second: merge `main` into it and resolve `.gitignore` by **keeping every rule from #30 and appending #33's single new line `mju-person-enrich.zip`** (#33 adds nothing else to that file). Proven 2026-10-09 with a simulated `main` (squash of #30): the only conflict is `.gitignore`, and the union keeps 11/11 of #30's PII/CSV/local-data rules. Needs approval before touching #33. |
| #34 | 8/8 green | clean | #30 (base); contains #33's 2 commits | Draft; do not mark Ready until #30 and #33 are in main. |

* #30 and #33 are otherwise file-disjoint (28 and 26 files, only `.gitignore` overlaps). The `fixtureRepositories.js` conflict only exists in #34 and is already resolved in `0d966f1`.
* Repo allows merge commit, squash and rebase; main has no branch protection. Recent main history uses squash (`(#32)`), so assume squash and plan for it.

### Plan to shrink PR #34's diff after #30 and #33 merge (needs approval at each step)

1. After #30 and #33 are in `main`: `git fetch origin` then **`git merge origin/main`** into `integration/attendance-sso-hip` (a normal merge, no rebase, no force-push). Because the squash result of #30/#33 has the same file content as the commits already in this branch, Git should auto-resolve; re-check `.gitignore` and `fixtureRepositories.js`.
2. `gh pr edit 34 --base main`. The PR diff then shows only the SSO / identifier work (roughly the 5 own commits plus docs), not #30 or #33.
3. Fast-forward push; CI re-runs automatically on the new base and head. Wait for 8/8 green, re-run the QA table in section 7 and check the migration order test below.
4. Only then consider marking Ready for Review (user decision).
* If #30/#33 end up merged with merge commits instead of squash, step 1 is a trivial fast-forward of history.

## 3. Key commits and branch relationships

```
main 3244553
 |- PR #30 line:   35fc993 -> 9ceb6ac -> 0448492 (merge main) -> 0a5e492   [work/pr30-secure-onboarding]
 |     -> 83aaa53 (National ID contract) -> 6e2bd60 (MJU/HIP identity kinds)  [feat/secure-identifier-integration]
 |     -> 5986749 (SSO identity chain) -> f63576c (fail-closed gates, mig 017) -> 343f54b (Simple SSO MVP)  [integration/sso-hip-identity]
 |- FaceScan line: c9f67a9 -> 00b92c5                                        [feat/facescan-ingestion-phase-a]
 \- 0d966f1 = merge of both lines                                            [integration/attendance-sso-hip]  <== current
```

All of `0d966f1`, `343f54b`, `6e2bd60`, `0a5e492` are reachable from the working branch, and every branch above is fully contained in it. The older local `main` (`e3cef26`) is stale; `origin/main` is `3244553`.

Merge conflicts resolved in `0d966f1`: `.gitignore` (union) and `backend/src/repositories/fixtureRepositories.js` (keep FaceScan `facescanIngestion` + `attendanceEvents`, keep identifier options from the SSO side).

## 4. Personnel scope (50 people)

* Source: `database/IDCardRaecsv2027.csv` (local only, gitignored, **never commit, never edit, never print values**). 52 data rows, 2 exact duplicate lines, so **50 unique people** is the confirmed scope. The earlier "expected 34" figure is retired.
* **Employee scope = 50 unique: CONFIRMED. It is not a blocker.** It is still not "import ready": import stays gated by the other items in section 8.
* CSV integrity baseline (SHA-256, recorded 2026-10-09): `65323DFF8D618834205E8BB07839CAA7133B1F8CF3C11E921EBE4C6546CF4443`. If it differs, someone edited the file; stop and report.
* Identity kinds (`backend/src/domain/identityKind.js`, `docs/IDENTITY_KIND_MAPPING.md`): `MJU` (has MJU `personnel_id`), `HIP` (contractor; HIP attendance only), `UNRESOLVED`. No synthetic `personnel_id` for HIP people.
* National ID: single contract in `backend/src/security/nationalIdContract.js` (HMAC-SHA-256 lookup + key version, strict canonicalization, raw storage off by default, masked output `****NNNN` only). Policy: `docs/NATIONAL_ID_PROTECTION_POLICY.md`.

## 5. Simple SSO (MJU) and HIP attendance

* Flow (`docs/SSO_MVP.md`): Login -> MJU SSO -> callback validation -> identity mapping -> Attendance session -> logout.
* Mapping: a verified SSO subject -> `employee_uid`; first login may link through the protected national ID; never by name or email alone; unknown or conflicting subject is denied.
* HIP attendance is separate: eligibility = an active `facescan_id` identifier. Contractors without an MJU account need **no** SSO and **no** fake SSO account. `Facescan Code` = HIP ID is documented but still unverified (`docs/HIP_ID_MAPPING_EVIDENCE.md`).
* Controls kept: single-use state bound to a server-generated cookie binding, single-use 45 s handoff code, HS256-pinned session JWT with `jti`, `no-store` and `no-referrer` on callback, logout revokes the refresh token, production refuses the mock provider and non-https endpoints. Deliberately cut for MVP: PKCE, state-count cap, multi-instance infra, advanced audit, key-rotation automation.
* Production detection reads `config.app.env` (use `isProduction(config)`).
* **Policy S9 (confirmed by the user, 2026-10-09):** a candidate link, or any link, must **never be auto-approved without evidence that the identity matches**. Acceptable evidence = a verified provider subject *and* a protected national-ID lookup (HMAC) that resolves to the same `employee_uid` in the same login. Never from name, email, a CSV row, an admin import alone, or the callback `ac`. Code review and tests (2026-10-09): in the live SSO path a `candidate` link is **never promoted**: `identityResolution.resolve()` throws `IDENTITY_NOT_APPROVED` (403) before any approval code runs, whether the national ID matches the same employee, another employee, or is absent. Four regression tests in `backend/tests/ssoIdentityRuntime.test.js` (prefix `S9:`) lock this, and were verified to fail under a mutation that treats `IDENTITY_NOT_APPROVED` as unknown. `ac`, email-shaped subjects and email/name-only profiles create no link.
* **Remaining S9 gap (planned, not yet changed in code):** (1) with `SSO_SUBJECT_CONTRACT_CONFIRMED=false` (the default) the subject extractor returns `unknown`, yet `issueSessionFromOAuthProfile` still issues a session from the national ID alone (no link, no verified identity). Minimal fix (~10 lines + 2 tests, no new SSO machinery): for a non-mock provider require `subjectExtraction.status === 'verified'`, else 403 `SSO_SUBJECT_NOT_VERIFIED` before issuing any session. Tests: live provider + unconfirmed subject + valid national ID -> 403, no session, no link; verified subject -> works as today. The existing userinfo probe mode (issues no session) stays the way to discover MJU's subject claim. (2) `linkProviderSubjectFromSsoLogin` still contains a candidate-to-approved promotion branch that is unreachable today; delete it in the same change (simplification, removes a latent S9 risk). (3) Record the evidence type on approvals instead of only `approvedBy: system:sso`. Needs approval before changing code.
* **Shortest MVP path (Login -> MJU -> Callback -> Identity Mapping -> Session -> Logout):** (1) get MJU's written answers (section 6) and a registered test callback; (2) set the confirmed values: endpoints, `SSO_NATIONAL_ID_CLAIMS`, `SSO_CALLBACK_CONFIRMED`, `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CONTRACT_CONFIRMED`, with secrets supplied by their owners (never in git); (3) `npm run sso:preflight` must report ready; (4) staging only, one consenting test account: login -> callback -> mapping -> session -> `/me` -> logout; (5) check the failure cases (bad callback, replayed code, unknown subject) against the existing `backend/tests/ssoMvp.test.js` behaviour; (6) only then decide whether to enable for the 50-person scope. HIP people skip all of this.
* Everything is fail-closed and OFF by default: `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CONTRACT_CONFIRMED`, and a non-empty `SSO_NATIONAL_ID_CLAIMS` for any non-mock provider. `npm run sso:preflight` prints a yes/no readiness check.

## 6. MJU protocol / callback `ac` (NOT confirmed)

Evidence matrix: `docs/SSO_PROTOCOL_EVIDENCE.md`. Do **not** assume OIDC.

* Confirmed: registered client and callback; portal `signin.aspx?cid=` form; `signout.aspx` redirect.
* Recorded but not independently observed: callback `GET ?ac=<32 chars>`. The meaning of `ac` (code? ticket? token?) is **unknown**.
* Inferred only (from donor code): OAuth2 code exchange, `openid` scope default.
* Unknown: token and userinfo endpoints, client secret, state echo, PKCE support, subject claim, citizen-ID claim name, signature. The MJU IT question list is in the evidence doc.
* No real MJU login has been attempted. A live probe needs MJU IT answers, a registered test callback, secrets from their owners and a consenting test account.

**What to ask MJU IT (only what is needed to accept the `ac` callback and fetch a verified identity):**
1. What is `ac` exactly: a one-time authorization code or ticket? Its lifetime, single-use rule, and whether it is bound to the client id / redirect URI.
2. How does our backend redeem or verify `ac` server-to-server: URL, HTTP method, authentication (client secret, IP allow-list, signature), request and response format, with a sample response for a synthetic or test user.
3. What identity fields come back: the stable, never-reused subject identifier (name and format) and the citizen-ID claim name (and whether it is a plain 13-digit value). Is the response signed, or protected by TLS only?
4. Is `state` echoed back unchanged, and is PKCE supported? (If not, we keep our own cookie binding.)
5. Registered callback URLs including a staging/test URL; a consenting test account; error-callback format; logout URL and whether logout is local only.
6. Written approval for releasing citizen ID to RAE (data-protection basis).
The full 15-question list stays in `docs/SSO_PROTOCOL_EVIDENCE.md`; the six above are the minimum for the MVP.

## 7. QA (latest, 2026-10-09; production code unchanged since `0d966f1`; later commits are docs and tests)

| Suite | Result |
|---|---|
| ESLint (backend) | clean |
| Backend (no DB) | 170 tests: 164 pass, 0 fail, 6 skipped (DB opt-in); includes 4 new `S9:` tests (local commit, not pushed) |
| Scripts | 36/36 pass |
| Secret scan (`node scripts/secret-scan.mjs`) | passed (287 files) |
| MariaDB QA (10.11.9 and 10.3.39, plain + binlog ROW/STATEMENT) | 34/34 pass |
| All migrations + seed on a fresh 10.11.9 DB | applied cleanly in order |
| DB integration (identifier, FaceScan, release1) on a fresh DB | 18/18 pass with `TZ=UTC` |
| PR #34 CI (head `2feb554`) | 8/8 jobs green (new S9 tests are local, not yet pushed) |
| PR #30 / #33 CI | 8/8 jobs green each |

Known issues:
* Two `facescanNormalization.mariadb.test.js` tests fail on a UTC+7 host (`15:00:00` vs `08:00:00`); the same failure exists at `00b92c5`; they pass with `TZ=UTC` (CI is UTC). Not caused by the SSO work.
* `facescanIngestion.mariadb.test.js` is not re-runnable on a used DB (idempotency returns `duplicate`); use a fresh DB each run.
* Opt-in env for DB suites: `RUN_MARIADB_TESTS=1` plus `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` (set them in the same shell call); QA suites use `RAE_QA_DB_PORTS` / `RAE_QA_BINLOG_PORTS` with `RAE_QA_DB_*`. MariaDB is not installed locally: use a throw-away portable download outside the repo and delete it afterwards.
* On Windows PowerShell here: call `git.exe` (the `git` shell function can be broken), and write commit messages to a temp file with `git commit -F`.

## 8. Migrations 015 / 017 and production gates

* Two files share the `015` prefix: `015_employee_identifier_secure_lookup.sql` (PR #30) and `015_facescan_hip_ingestion.sql` (PR #33). `scripts/migrate.mjs` keys the ledger (`schema_migrations`) on the full filename, sorts lexicographically, applies any file not in the ledger, and has no checksum. Order is deterministic and there is no cross dependency. **Do not rename** either file: a database that already applied it would treat the renamed file as new. Any rename is a separate coordinated decision.
* Evidence (2026-10-09, disposable MariaDB 10.11.9, no real data): (a) fresh DB, all 19 files in order: OK; (b) DB at the #33 state (015_facescan, 016, seeded) then this branch's `013_personnel_identifier`, `015_employee_identifier_secure_lookup`, `017`: applied cleanly, seeded rows kept; (c) DB at the #30 state then `015_facescan`, `016`, `017`: applied cleanly. So either merge order works at the schema level. Not tested: a DB that already holds real production data.
* Two `013_*` files: `013_employee_identifier_foundation.sql` is on `origin/main`; `013_personnel_identifier.sql` (PR #30 only, never on main) is a no-op `SELECT 1;` stub kept so a ledger that recorded the earlier DDL stays consistent.
* The merge flow does not change migration files, so no ledger rewrite is needed.
* `017_identifier_namespace_claim.sql` (claim table + triggers, `SIGNAL 45000 IDENTIFIER_NAMESPACE_COLLISION`; a value may not be `facescan_id` for one employee and `personnel_id` for another). Under binary logging the migration account needs `SUPER` or `log_bin_trust_function_creators=1` (TRIGGER alone fails with error 1419; missing TRIGGER gives 1142; triggers run as DEFINER). Details: `docs/MIGRATION_017_PRIVILEGES.md`. Run `database/preflight/015_preflight.sql` and `017_preflight.sql` read-only before any real DB; rollbacks live in `database/rollbacks/`.
* **Production gates (still BLOCKED, need explicit written approval):** MJU authoritative personnel source; VPS gate; HIP ID evidence; DBA decision on migration 017 privileges; MJU IT answers on the SSO contract (`ac` handling and verified identity). **Not a blocker any more:** the 50-unique employee scope (CONFIRMED). Policy S9 is decided (section 5); only its hardening items remain as code work.
* Never without approval: push to a protected line, merge a PR, SSH, production migration/import/deploy, create or rotate production secrets, edit the original CSV, force-push.

## 9. Suggested next steps

0. **Approval gates, in order (each needs its own explicit approval; nothing is merged automatically):** (a) push the local S9-test and handoff commits to PR #34; (b) merge #30; (c) update #33 (merge main, resolve `.gitignore` as in section 2) and merge #33; (d) merge main into #34, retarget base to `main`, wait for CI, then decide on Ready for Review.
1. Approve the merge order #30 -> #33 -> #34. #33 needs a small `.gitignore` update after #30 lands. Then follow "Plan to shrink PR #34's diff" (section 2). Keep #34 a Draft until then.
2. Keep the duplicate `015` prefix as is (evidence in section 8); a rename needs a separate decision.
3. Send the MJU IT question list (`docs/SSO_PROTOCOL_EVIDENCE.md`) and obtain the registered test callback, secrets and a consenting test account; then run a staging-only live probe to learn what `ac` actually is.
4. DBA decision for migration 017 (`SUPER` or `log_bin_trust_function_creators=1`, stable definer).
5. Approve and implement the S9 gap fix (section 5: require a verified subject for any non-mock provider, delete the unreachable candidate-promotion branch); the S9 regression tests already exist; resolve the HIP ID evidence; only then plan the controlled onboarding (`docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/PRODUCTION_DATA_ONBOARDING_PLAN.md`).
6. Optional hygiene: fix the timezone assumption in the two FaceScan normalization tests; remove the stale `feat/attendance-core-service` local branch (its remote is gone) only after confirming nothing unique is on it.

## 10. Key documents

`docs/SSO_MVP.md`, `docs/SSO_PROTOCOL_EVIDENCE.md`, `docs/PR_REVIEW_SSO_INTEGRATION.md`, `docs/MIGRATION_017_PRIVILEGES.md`, `docs/IDENTITY_KIND_MAPPING.md`, `docs/HIP_ID_MAPPING_EVIDENCE.md`, `docs/NATIONAL_ID_PROTECTION_POLICY.md`, `docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/SSO_READINESS.md`, `docs/FACESCAN_INGESTION.md`.
