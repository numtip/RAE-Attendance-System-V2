# Release readiness — 2026-10-29 (end of day)

**Gate:** `ENGINEERING_GREEN_SINGLE_BLOCKER_RETIRED` · **Production:** still frozen, nothing deployed.
**Not claimed:** `PRODUCTION_READY`, `DARK_DEPLOY_READY` (see §5), incident resolved, import ready.

## 1. Merged today (squash SHAs on `main`)

| PR | Squash | What it changed |
|---|---|---|
| #79 | `0e9fd89` | the refresh-reuse assertions now hold in **every** ordering — this is what made `main`'s CI stop being red at random |
| #45 | `1205fdc` | identity subject guard moved into the domain + a **closed** source allowlist (was bypassable by inventing a source) |
| #81 | `bce4fee` | facescan staging repository aligned with the schema `015_facescan` actually created (`ER_BAD_FIELD_ERROR` before) |
| #82 | `1e93d46` | ID-7b: the enrichment-outcome guard **fails closed** — it had never fired on MariaDB |
| #78 (earlier) | `3066505` | the security slices run against MariaDB 10.11.14 at all |

`main` at the time of writing: **`1e93d46`** plus the open PRs below.

## 2. QA actually executed (not asserted)

| Gate | Command | Result |
|---|---|---|
| backend suite, no DB | `node --test tests/*.test.js` | **337 tests, 318 pass, 0 fail, 19 skipped** |
| backend suite, MariaDB 11.4 + 26 migrations + seed | CI replica in a disposable container | **292 tests, 285 pass, 0 fail, 7 skipped** |
| migrations | `npm run db:migrate` twice | **26 apply** then **0 apply / 26 skip** — ledger idempotent |
| rollback | `database/rollbacks/*.down.sql` | 10 of 26 have one; all 10 round-trip; **16 have none** (unchanged gap) |
| security slices (the flaky one) | exact CI command, 8 fresh runs | **8/8 pass** after #79 (was 3/6 failing) |
| contract smoke | `npm run contract:smoke` | ok — 18 `API_CONTRACT` paths |
| secret scan | `scripts/secret-scan.mjs` | clean, 343 tracked files |
| national-ID digest on real MariaDB | `nationalIdDigest.mariadb.test.js` | pass — digest stored, raw refused by repository **and** by `chk_employee_identifier_national_lookup` |
| key-version audit (N-2) | `scripts/national-id-key-versions.mjs` | exit 0 clean / **exit 2 orphaned**, proved against a real server |
| N-6 migration 029 | up, abort-when-rows-exist, down, re-up | all four behaviours verified in a disposable container |
| facescan staging | `facescanStaging.mariadb.test.js` | pass — full batch → row → resolve → commit lifecycle |
| rule engine (D-10 groundwork) | `attendanceRuleEngine.test.js` | **12/12** boundary tests; module is unwired, so behaviour is unchanged |

## 3. Open pull requests and their state

| PR | Head | Purpose | Gate |
|---|---|---|---|
| #60 | rebased onto `1e93d46` | national-ID stored only as versioned HMAC digests; protector wiring fixed; real-MariaDB tests added; N-2/N-3 closed | awaits CI + the privacy decisions in §4 |
| #83 | `feat/n6-subject-key-migration` | N-6: migration 029 + rollback + operator backfill + duplicate detection | **file only — the production migration is not approved** |
| #80 | `proposal/n-6-national-id-subject-key` | the N-6 design record + the DDL test | documentation |
| this branch | `feat/rule-engine-isolated` | ADR-014 + unwired engine + boundary tests | direction approved, wiring not |

## 4. Unresolved owner decisions (unchanged by today's work)

| # | Decision | Why it still blocks |
|---|---|---|
| **N-1** | retention of a digest and its key version, and the lawful basis | a digest is still personal data while the key exists |
| **N-5** | which MariaDB version is authoritative (repo pins 11.4; two suites demand 10.11.14) | CI now runs both, so the ambiguity is visible rather than fixed |
| **N-6** | approve applying migration 029 in production | the guard is **partial** until a real backfill runs, and backfill needs raw IDs from source systems |
| **S1** | history rewrite vs accept-and-contain for the national-ID exposure | source is contained; **history is not** |
| **S3** | who performs the PDPA notification assessment, and by when | nothing notifies anyone |
| **D-13** | the R1/R3 privacy-incident package | open |
| **facescan promotion** | `staging_facescan_raw → attendance_events` | needed under *both* D-10 options; it is in **no** PR |

## 5. Why this is not `DARK_DEPLOY_READY` yet

`DARK_DEPLOY_READY` would mean: the artifact deploys with every feature dark, and can be proven to do nothing
harmful. Three things are still missing, and none of them is "more code":

1. **No deploy path is exercised.** Nothing in this session touched a host, and the deploy runbooks have not
   been dry-run against the current `main`. (VPS operations are explicitly out of scope — Cursor owns the VPS.)
2. **The feature flags are not enumerated as a deploy dimension.** SSO is off, national-ID matching is off
   without a key, the rule engine has no caller — that is accidentally dark, which is not the same as
   *verifiably* dark.
3. **The import is 0 of 54 rows ready** on owner answers (`F5`, `F6`, `F10`, `O-4`, `O-5`, `M1`), so a dark
   deploy would have no data to be dark about.

What *is* true: `main` is green, the two P0 guards are merged and proven on MariaDB, the security slices are
deterministic, and the remaining work is owner decisions plus one missing component — not unknown defects.

## 6. Costs (this session, DeepSeek V4 Flash only)

Session: **$0.1987** across 207 API calls → **$0.00096/call**; cache-read is **99.45%** of input tokens, i.e.
the cost is conversation context re-sent per turn, not new work. Five deliverables today (flake fix, facescan
alignment, identity guard, N-6 migration + tooling, rule engine + ADR) ≈ **$0.26 per completed task**.
Loop limits applied: `max_turns 120`, `api_max_retries 2`, `hard_stop_enabled`, `delegation.max_iterations 60`,
`background_review.max_input_tokens 120000`. Rollback: `config.yaml.bak-cost-20261029T213058`.
