# Session Handoff

Last updated: 2026-10-09 (candidate subject committed for Draft PR #34; do not merge). Read this file **before** starting any work.
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
| PR #34 `integration/attendance-sso-hip` (head `b8ba918` on origin) | **Draft**, OPEN, base `docs/mju-subject-evidence-pack`; CI 8/8 green on `b8ba918`; keep Draft |
| `origin/main` | `3244553` |

* Fast-forward push to `integration/attendance-sso-hip` is the approved Draft PR #34 update (no force). It does not merge and does not update `main`. Commits after `b8ba918`: handoff/VPS checklist, MJU token flow, then the candidate-subject commit. PR #34 stays Draft.
* PR #34 range = 5 own commits + 2 FaceScan commits (the same ones as PR #33) + 1 merge commit + docs commits. Merge order: **#30 -> #33 -> #34**.

### Merge readiness (reviewed 2026-10-09)

| PR | CI | Mergeable | Depends on | Verdict |
|---|---|---|---|---|
| #30 | 8/8 green | clean | main | Ready technically (28 files, +2533/-11; 0 reviews/comments; 0 CSV-value hits, no forbidden files). Before merge: (1) title and body were rewritten on 2026-10-09 to match reality (migration 015, onboarding scripts, security policy; no runtime code); (2) migration 015 adds a CHECK that rejects plaintext `national_id` rows, and the HMAC protector code that writes them lives in #34, so **do not migrate any real DB from `main` after #30 alone**; apply 015 only together with the #34 backend and after `015_preflight.sql`; (3) touches `.gitignore`, which #33 also touches. |
| #33 | 8/8 green | clean vs main today | main (independent of #30) | Ready technically **but** after #30 merges it conflicts with main on `.gitignore` (proven with `git merge-tree 0a5e492 00b92c5`). #33 needs a small update before merging second: merge `main` into it and resolve `.gitignore` by **keeping every rule from #30 and appending #33's single new line `mju-person-enrich.zip`** (#33 adds nothing else to that file). Proven 2026-10-09 with a simulated `main` (squash of #30): the only conflict is `.gitignore`, and the union keeps 11/11 of #30's PII/CSV/local-data rules. Needs approval before touching #33. |
| #34 | 8/8 green | clean | #30 (base); contains #33's 2 commits | Draft; do not mark Ready until #30 and #33 are in main. |

* #30 and #33 are otherwise file-disjoint (28 and 26 files, only `.gitignore` overlaps). The `fixtureRepositories.js` conflict only exists in #34 and is already resolved in `0d966f1`.
* Repo allows merge commit, squash and rebase; main has no branch protection. Recent main history uses squash (`(#32)`), so assume squash and plan for it.

### Auto-deploy / auto-migrate check (2026-10-09, read-only)
* Workflows: only `ci.yml` (runs on every PR and on push to `main`) and `pages.yml` (push to `main`). No deploy, SSH or production-DB step; no Actions secrets or variables exist; no repo webhooks; migrations in CI run only against a throw-away MariaDB service container. `scripts/migrate.mjs` is manual (`npm run db:migrate*`), defaults to `127.0.0.1`, and nothing in the repo invokes it against a real host.
* Merging to `main` therefore triggers CI and a **public GitHub Pages deploy of the frontend in `VITE_REVIEW_MODE=fixture`** (synthetic data, no backend). The repo is **public**. #30 and #33 change no frontend files; #34 adds the SSO complete view and a router entry, which would be published in fixture mode.
* Not verifiable from the repo (needs the VPS owner, no SSH was used): whether the legacy host pulls `main` by cron/hook. `deploy/README.md` states nothing is applied there without an approved cutover (GitHub-first / VPS-last). Ask the operator to confirm before the first merge.

### `.gitignore` resolution for #33 (run only after #30 is merged and with approval)
1. `git fetch origin`; `git switch feat/facescan-ingestion-phase-a` (clean tree first); `git merge origin/main`.
2. Conflict is `.gitignore` only. Take main's file (which has all of #30's rules) and append one line: `mju-person-enrich.zip`. Do not delete any rule.
3. Check before committing: `git diff origin/main -- .gitignore` shows only that added line; `git check-ignore -v database/IDCardRaecsv2027.csv database/local/x docs/IDCardRaecsv2027_IMPORT_PLAN.md` still reports each as ignored; the 11 #30 rules are still present: `.local/onboarding-snapshots/`, `.local/import-batches/`, `database/local/`, `**/IDCard*.csv`, `**/IDCard*.xlsx`, `**/IDCard*.xls`, `**/IDCardRaecsv*`, `**/*person-batch-input*.json`, `**/*person-batch-input*.csv`, `!database/preflight/*.sql`, `!database/rollbacks/*.sql`.
4. Commit, push fast-forward, wait for CI 8/8. Never `git add -A`.

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
* **S9 fix (commit `966562b`, pushed):** `issueSessionFromOAuthProfile` now requires a verified MJU subject before any employee lookup: invalid proof (`ac`, email-shaped, email-only) -> 403 `SSO_SUBJECT_INVALID`; missing subject or unconfirmed subject contract -> 403 `SSO_SUBJECT_NOT_VERIFIED`. A citizen ID alone never opens a session (applies to every provider, including `mock`, so dev mock login needs `SSO_SUBJECT_CONTRACT_CONFIRMED=true`). `mjuSubjectAdapter` also rejects a profile subject equal to `ac`/the callback `ac`. The unreachable candidate-to-approved branch in `linkProviderSubjectFromSsoLogin` was deleted. Four new `S9:` tests; verified to fail (4 failures) without the fix. Still open (low): record the evidence type on approvals instead of only `approvedBy: system:sso`.
* **Shortest staging path (Login -> MJU -> Callback -> Identity Mapping -> Session -> Logout):** (1) set, outside git, `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_MJU_TOKEN_FLOW=true`, `SSO_SIGNIN_URL`, `SSO_TOKEN_URL`, `SSO_SUBJECT_CLAIM=humanID` (or `personID` only if the operator chooses that candidate). Leave `SSO_PROTOCOL_CONTRACT_CONFIRMED` and `SSO_SUBJECT_CONTRACT_CONFIRMED` **false**. No client secret. (2) `npm run sso:preflight` must exit 0 in mode `mju token flow` and list the residual risks. (3) one consenting staging account: login -> callback -> mapping -> session -> `/me` -> logout. (4) failure cases: missing `ac`, replayed `ac`, missing `humanID`, ambiguous `humanID`, subject equal to citizen ID / e-mail / name, unknown citizen ID, subject linked to another employee. (5) only then decide whether to enable for the 50-person scope. HIP people skip all of this.
* Everything is fail-closed and OFF by default: `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_MJU_TOKEN_FLOW`, `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CONTRACT_CONFIRMED`. `npm run sso:preflight` prints a yes/no readiness check. The two `*_CONTRACT_CONFIRMED` flags are OAuth-only and must not be turned on to describe the token flow as MJU-certified.

## 6. MJU protocol / callback `ac` (NOT confirmed)

Evidence matrix: `docs/SSO_PROTOCOL_EVIDENCE.md`. Do **not** assume OIDC.

* Confirmed: registered client and callback; portal `signin.aspx?cid=` form; `signout.aspx` redirect.
* Recorded but not independently observed: callback `GET ?ac=<32 chars>`. The meaning of `ac` (code? ticket? token?) is **unknown**.
* Inferred only (from donor code): OAuth2 code exchange, `openid` scope default.
* Unknown: token and userinfo endpoints, client secret, state echo, PKCE support, subject claim, citizen-ID claim name, signature. The MJU IT question list is in the evidence doc.
* **MJU SSO adapter flow** (`SSO_MJU_TOKEN_FLOW=true`, default OFF): `GET /auth/sso/login` -> `signin.aspx?cid=` -> callback `?ac=` -> backend `POST token.aspx` with JSON `{clientID, code}` -> candidate subject from `SSO_SUBJECT_CLAIM` (default `humanID`) **and** `citizenID` -> HMAC lookup -> Attendance session. No OAuth/OIDC step, no client secret, no userinfo call. `SSO_PROTOCOL_CONTRACT_CONFIRMED` and `SSO_SUBJECT_CONTRACT_CONFIRMED` are **not** required and must stay false: they mean MJU IT certified the contract, which has not happened. A missing claim, a disagreeing multi-value claim (`SSO_SUBJECT_AMBIGUOUS`), or a subject that collides with `ac`, the citizen ID, an e-mail or a name fails closed with no fallback. First-login links are stored as `source=mju_token_candidate_subject`, `subjectType=candidate:<claim>`, `confidence=medium`. Code: `backend/src/services/sso/mjuTokenClient.js`, `mjuPortalGuard.js`, `ssoService.js` (`handleMjuPortalCallback`), `ssoIdentityResolutionService.js` (`source: 'mju_token'`). Tests: `backend/tests/ssoMjuTokenFlow.test.js`.
* **Owner decision 2026-10-09:** Phase B (MJU IT written confirmation) is skipped. Vendor-sample evidence may be used for a staging pilot. That decision does not certify `humanID`, `ac` lifetime, single-use at MJU, response signing, or citizen-ID release. Residual risks and staging gates are in section 6.
* **Vendor sample `docs/sampleCallback.aspx(.vb)`** stays untracked and must not be committed. It is vendor evidence, not a signed contract.
* No real MJU login has been attempted.

### Residual risks (Phase B skipped) and staging pilot gates

Residual, accepted until a later written answer exists:

1. `ac` lifetime, single-use at MJU, and binding to client id / redirect URI are unknown. Local replay protection is in-memory, per process, and does not survive a restart.
2. MJU does not echo `state`. The HttpOnly `SameSite=Lax` cookie binds the callback to a browser that started login here. It does not prove this `ac` belongs to that login (login-CSRF window = binding TTL, 10 minutes).
3. `humanID` is a candidate. It may not be stable or unique for every person. A collision with an existing link fails closed (`409`). It is not certified by MJU IT.
4. The token response is trusted over TLS only. It is not signed. A wrong `token.aspx` URL would be trusted.
5. Citizen-ID release to RAE has no written data-protection basis yet. The pilot must use one consenting account.
6. More than one backend instance does not share the replay/binding store.

Staging pilot gates (all must pass before any wider enablement; none of these are a production deploy):

| Gate | Pass condition |
|---|---|
| Flags | `SSO_MJU_TOKEN_FLOW=true`; both `*_CONTRACT_CONFIRMED` flags false; preflight exit 0 |
| Account | one consenting person, staging callback only |
| Success | login, callback, HMAC map, `/me`, logout, refresh token revoked |
| Fail closed | replayed `ac`, missing cookie, missing/ambiguous subject, subject = citizen ID or name or e-mail, unknown citizen ID, cross-employee subject: no session and no new link |
| Audit | new link row is `candidate:humanID` (or `candidate:personID`), source `mju_token_candidate_subject`, confidence `medium` |
| Rollback | set `SSO_ENABLED=false` or `SSO_MJU_TOKEN_FLOW=false` and restart; no migration is required for this pilot |

**What remains useful to ask MJU IT later** (not a blocker for the staging pilot):
1. What is `ac` exactly: a one-time authorization code or ticket? Its lifetime, single-use rule, and whether it is bound to the client id / redirect URI.
2. How does our backend redeem or verify `ac` server-to-server: URL, HTTP method, authentication (client secret, IP allow-list, signature), request and response format, with a sample response for a synthetic or test user.
3. What identity fields come back: the stable, never-reused subject identifier (name and format) and the citizen-ID claim name (and whether it is a plain 13-digit value). Is the response signed, or protected by TLS only?
4. Is `state` echoed back unchanged, and is PKCE supported? (If not, we keep our own cookie binding.)
5. Registered callback URLs including a staging/test URL; a consenting test account; error-callback format; logout URL and whether logout is local only.
6. Written approval for releasing citizen ID to RAE (data-protection basis).
The full 15-question list stays in `docs/SSO_PROTOCOL_EVIDENCE.md`; the six above are the minimum for the MVP.

## 7. QA (latest, 2026-10-09, after the candidate-subject change; not committed)

| Suite | Result |
|---|---|
| ESLint (changed SSO files) | clean |
| Backend `npm test` (no DB) | 185 pass, 0 fail, 6 skipped, then token-flow cookie Path/`Secure`, cap-eviction and the renamed gate test were added (`ssoMjuTokenFlow.test.js` 18/18) |
| Secret scan | passed (292 tracked files). `docs/sampleCallback.aspx(.vb)` stayed untracked |
| `sso:preflight` with empty env | exit 1 (SSO off) |
| `sso:preflight` with synthetic token-flow flags, both contract flags false | exit 0, mode `mju token flow`, residual risks listed |
| Mutation | blanking the ambiguous-subject throw failed `ssoMjuTokenFlow` (2 tests); throw restored; those 2 tests pass again |
| MariaDB / DB integration | not re-run (no schema change; suites stay opt-in). Previous result on 2026-10-09: MariaDB QA 34/34, fresh migrate+seed OK, DB integration 18/18 with `TZ=UTC` |
| PR CI | #30, #33, and #34 at `b8ba918` were 8/8 green. Local commits after `b8ba918` are not on the PR yet |

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

### VPS read-only verification checklist (for the VPS administrator; agents must not SSH)

Purpose: before the first merge to `main`, confirm that nothing on the legacy host pulls `main`, runs migrations, or serves a branch that could break. Run **only read-only commands**; do not edit, restart, pull, migrate or deploy anything. Send back the output with secrets, passwords, tokens and personal data redacted. Paths below are examples; use the real deployment directory.

1. **Host and runtime identity:** `hostname; whoami; date -u; uname -a; cat /etc/os-release | head -3`; `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'` (or `systemctl list-units --type=service --state=running | grep -i -E 'rae|node|pm2|nginx'`, `pm2 list` if PM2 is used). Record which process serves the attendance app and on which port.
2. **Active branch and commit (read-only):** `cd <deploy dir>; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD; git status --short | head; git remote -v` (remove any credentials from the URL before replying); `git log -1 --format='%H %cd %s'`; `git fetch --dry-run 2>&1 | head` is optional and only if the admin accepts a network read.
3. **Auto-pull:** `crontab -l; sudo crontab -l -u <deploy user>; ls /etc/cron.d /etc/cron.daily /etc/cron.hourly; systemctl list-timers --all | head -30`; search them for `git pull`, `git fetch`, `deploy`, `rae`. Also check webhook receivers: `ps aux | grep -i -E 'webhook|adnanh|hooks|deploy' | grep -v grep`, `docker ps | grep -i -E 'watchtower|webhook'`, and `ls ~/.config 2>/dev/null` for CI runners (`ps aux | grep -i runner`). Answer plainly: **does anything on this host pull or deploy `main` automatically? yes/no, how, how often.**
4. **Auto-migrate:** `grep -R -n -i -E 'db:migrate|migrate\.mjs|schema_migrations|npm run db' <deploy dir>/package.json <deploy dir>/deploy /etc/systemd/system 2>/dev/null | head`; check the container entrypoint or compose `command:` for migration steps (`docker inspect <container> --format '{{.Config.Cmd}} {{.Config.Entrypoint}}'`). Answer: **is any migration run at start-up, by cron, or by the deploy script? yes/no.**
5. **Database state (read-only, no data):** with a read-only account, `SELECT version FROM schema_migrations ORDER BY version;` (names only, no row data) and `SELECT VERSION();`, `SHOW VARIABLES LIKE 'log_bin%';`. This tells which of `013`, `015` (two files), `016`, `017` are already applied. Do not run `SELECT` on employee or identifier tables.
6. **Exposure:** `ss -tlnp | head -30` and the reverse-proxy site config (names only, no secrets) to confirm what is public.
7. **Reply format:** a short yes/no table: auto-pull (yes/no), auto-migrate (yes/no), active branch, active commit, runtime host (container/PM2/systemd), last applied migration name, DB `log_bin` on/off. Anything unexpected = stop and report; do not change it.

Decision rule: if the answer to 3 or 4 is "yes", or the active branch is `main`, **BLOCK the first merge** until the admin disables the automation or confirms that the merged content is safe (the docs-only #30 still adds migration files that an auto-migrate would apply).

## 9. Suggested next steps

0. **Approval gates, in order (each needs its own explicit approval; nothing is merged automatically):** (a) merge #30; (b) update #33 (merge main, resolve `.gitignore` as below) and merge #33; (c) merge main into #34, retarget base to `main`, wait for CI, then decide on Ready for Review.
2. Keep the duplicate `015` prefix as is (evidence in section 8); a rename needs a separate decision.
3. Send the MJU IT question list (`docs/SSO_PROTOCOL_EVIDENCE.md`) and obtain the registered test callback, secrets and a consenting test account; then run a staging-only live probe to learn what `ac` actually is.
4. DBA decision for migration 017 (`SUPER` or `log_bin_trust_function_creators=1`, stable definer).
5. The S9 fix is committed locally (`966562b`); approve pushing it; record the evidence type on approvals (low priority); resolve the HIP ID evidence; only then plan the controlled onboarding (`docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/PRODUCTION_DATA_ONBOARDING_PLAN.md`).
6. Optional hygiene: fix the timezone assumption in the two FaceScan normalization tests; remove the stale `feat/attendance-core-service` local branch (its remote is gone) only after confirming nothing unique is on it.

## 10. Key documents

`docs/SSO_MVP.md`, `docs/SSO_PROTOCOL_EVIDENCE.md`, `docs/PR_REVIEW_SSO_INTEGRATION.md`, `docs/MIGRATION_017_PRIVILEGES.md`, `docs/IDENTITY_KIND_MAPPING.md`, `docs/HIP_ID_MAPPING_EVIDENCE.md`, `docs/NATIONAL_ID_PROTECTION_POLICY.md`, `docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/SSO_READINESS.md`, `docs/FACESCAN_INGESTION.md`.
