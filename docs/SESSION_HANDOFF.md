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
| PR #34 `integration/attendance-sso-hip` (head `0d966f1`) | **Draft**, OPEN, base `docs/mju-subject-evidence-pack`; CI all green (8 jobs) |
| `origin/main` | `3244553` |

* Pushed: `integration/attendance-sso-hip` (new branch, fast-forward only, no force). Nothing has been merged.
* PR #34 range = 5 own commits + 2 FaceScan commits (the same ones as PR #33) + 1 merge commit. Suggested merge order: **#30 -> #33 -> #34**; after #33 lands, rebase/retarget #34 so the two FaceScan commits drop out of its diff.

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
* 50 unique rows is a confirmed *scope*, not "import ready": import stays gated (section 8).
* CSV integrity baseline (SHA-256, recorded 2026-10-09): `65323DFF8D618834205E8BB07839CAA7133B1F8CF3C11E921EBE4C6546CF4443`. If it differs, someone edited the file; stop and report.
* Identity kinds (`backend/src/domain/identityKind.js`, `docs/IDENTITY_KIND_MAPPING.md`): `MJU` (has MJU `personnel_id`), `HIP` (contractor; HIP attendance only), `UNRESOLVED`. No synthetic `personnel_id` for HIP people.
* National ID: single contract in `backend/src/security/nationalIdContract.js` (HMAC-SHA-256 lookup + key version, strict canonicalization, raw storage off by default, masked output `****NNNN` only). Policy: `docs/NATIONAL_ID_PROTECTION_POLICY.md`.

## 5. Simple SSO (MJU) and HIP attendance

* Flow (`docs/SSO_MVP.md`): Login -> MJU SSO -> callback validation -> identity mapping -> Attendance session -> logout.
* Mapping: a verified SSO subject -> `employee_uid`; first login may link through the protected national ID; never by name or email alone; unknown or conflicting subject is denied.
* HIP attendance is separate: eligibility = an active `facescan_id` identifier. Contractors without an MJU account need **no** SSO and **no** fake SSO account. `Facescan Code` = HIP ID is documented but still unverified (`docs/HIP_ID_MAPPING_EVIDENCE.md`).
* Controls kept: single-use state bound to a server-generated cookie binding, single-use 45 s handoff code, HS256-pinned session JWT with `jti`, `no-store` and `no-referrer` on callback, logout revokes the refresh token, production refuses the mock provider and non-https endpoints. Deliberately cut for MVP: PKCE, state-count cap, multi-instance infra, advanced audit, key-rotation automation.
* Production detection reads `config.app.env` (use `isProduction(config)`).
* Everything is fail-closed and OFF by default: `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CONTRACT_CONFIRMED`, and a non-empty `SSO_NATIONAL_ID_CLAIMS` for any non-mock provider. `npm run sso:preflight` prints a yes/no readiness check.

## 6. MJU protocol / callback `ac` (NOT confirmed)

Evidence matrix: `docs/SSO_PROTOCOL_EVIDENCE.md`. Do **not** assume OIDC.

* Confirmed: registered client and callback; portal `signin.aspx?cid=` form; `signout.aspx` redirect.
* Recorded but not independently observed: callback `GET ?ac=<32 chars>`. The meaning of `ac` (code? ticket? token?) is **unknown**.
* Inferred only (from donor code): OAuth2 code exchange, `openid` scope default.
* Unknown: token and userinfo endpoints, client secret, state echo, PKCE support, subject claim, citizen-ID claim name, signature. The MJU IT question list is in the evidence doc.
* No real MJU login has been attempted. A live probe needs MJU IT answers, a registered test callback, secrets from their owners and a consenting test account.

## 7. QA (latest, 2026-10-09, on `0d966f1`)

| Suite | Result |
|---|---|
| ESLint (backend) | clean |
| Backend (no DB) | 166 tests: 160 pass, 0 fail, 6 skipped (DB opt-in) |
| Scripts | 36/36 pass |
| Secret scan (`node scripts/secret-scan.mjs`) | passed (287 files) |
| MariaDB QA (10.11.9 and 10.3.39, plain + binlog ROW/STATEMENT) | 34/34 pass |
| All migrations + seed on a fresh 10.11.9 DB | applied cleanly in order |
| DB integration (identifier, FaceScan, release1) on a fresh DB | 18/18 pass with `TZ=UTC` |
| PR #34 CI | 8/8 jobs green |

Known issues:
* Two `facescanNormalization.mariadb.test.js` tests fail on a UTC+7 host (`15:00:00` vs `08:00:00`); the same failure exists at `00b92c5`; they pass with `TZ=UTC` (CI is UTC). Not caused by the SSO work.
* `facescanIngestion.mariadb.test.js` is not re-runnable on a used DB (idempotency returns `duplicate`); use a fresh DB each run.
* Opt-in env for DB suites: `RUN_MARIADB_TESTS=1` plus `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` (set them in the same shell call); QA suites use `RAE_QA_DB_PORTS` / `RAE_QA_BINLOG_PORTS` with `RAE_QA_DB_*`. MariaDB is not installed locally: use a throw-away portable download outside the repo and delete it afterwards.
* On Windows PowerShell here: call `git.exe` (the `git` shell function can be broken), and write commit messages to a temp file with `git commit -F`.

## 8. Migrations 015 / 017 and production gates

* Two files share the `015` prefix: `015_employee_identifier_secure_lookup.sql` (PR #30) and `015_facescan_hip_ingestion.sql` (PR #33). `scripts/migrate.mjs` keys the ledger (`schema_migrations`) on the full filename, sorts lexicographically, and has no checksum. Order is deterministic and there is no cross dependency. **Do not rename** either file: a database that already applied it would treat the renamed file as new. Any rename is a separate coordinated decision.
* `013_personnel_identifier.sql` is a no-op stub kept for ledger stability.
* `017_identifier_namespace_claim.sql` (claim table + triggers, `SIGNAL 45000 IDENTIFIER_NAMESPACE_COLLISION`; a value may not be `facescan_id` for one employee and `personnel_id` for another). Under binary logging the migration account needs `SUPER` or `log_bin_trust_function_creators=1` (TRIGGER alone fails with error 1419; missing TRIGGER gives 1142; triggers run as DEFINER). Details: `docs/MIGRATION_017_PRIVILEGES.md`. Run `database/preflight/015_preflight.sql` and `017_preflight.sql` read-only before any real DB; rollbacks live in `database/rollbacks/`.
* **Production gates (all still BLOCKED, need explicit written approval):** MJU authoritative personnel source; employee scope; VPS gate; HIP ID evidence; DBA decision on migration 017 privileges; MJU IT answers on the SSO contract; policy S9 (candidate-link auto-approval, national-ID-only sessions while the subject contract is unconfirmed; see `docs/PR_REVIEW_SSO_INTEGRATION.md`).
* Never without approval: push to a protected line, merge a PR, SSH, production migration/import/deploy, create or rotate production secrets, edit the original CSV, force-push.

## 9. Suggested next steps

1. Decide the merge order of PR #30 / #33 / #34; mark #34 ready for review when appropriate; rebase or retarget #34 after #33 merges.
2. Decide on the duplicate `015` prefix (keep as is, or a coordinated rename before any DB applies both).
3. Send the MJU IT question list (`docs/SSO_PROTOCOL_EVIDENCE.md`) and obtain the registered test callback, secrets and a consenting test account; then run a staging-only live probe to learn what `ac` actually is.
4. DBA decision for migration 017 (`SUPER` or `log_bin_trust_function_creators=1`, stable definer).
5. Resolve policy S9 and the HIP ID evidence; only then plan the controlled onboarding (`docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/PRODUCTION_DATA_ONBOARDING_PLAN.md`).
6. Optional hygiene: fix the timezone assumption in the two FaceScan normalization tests; remove the stale `feat/attendance-core-service` local branch (its remote is gone) only after confirming nothing unique is on it.

## 10. Key documents

`docs/SSO_MVP.md`, `docs/SSO_PROTOCOL_EVIDENCE.md`, `docs/PR_REVIEW_SSO_INTEGRATION.md`, `docs/MIGRATION_017_PRIVILEGES.md`, `docs/IDENTITY_KIND_MAPPING.md`, `docs/HIP_ID_MAPPING_EVIDENCE.md`, `docs/NATIONAL_ID_PROTECTION_POLICY.md`, `docs/CONTROLLED_EMPLOYEE_ONBOARDING.md`, `docs/SSO_READINESS.md`, `docs/FACESCAN_INGESTION.md`.
