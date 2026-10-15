# 07 — Slice 2: Versioned Attendance Engine + Agent Core integration

Status: **`SLICE2_READY_FOR_REVIEW`** — implementation complete, tests green locally, CI green on the PR.
**Not pushed to `main`, not merged, no migration applied to any host.**

Supersedes nothing. Extends [`06_SLICE1_EMPLOYEE_MASTER_AND_ATTENDANCE_FOUNDATION.md`](06_SLICE1_EMPLOYEE_MASTER_AND_ATTENDANCE_FOUNDATION.md)
(PR [#36](https://github.com/numtip/RAE-Attendance-System-V2/pull/36)), which this slice is stacked on.

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-15 (Asia/Bangkok) |
| Branch | `feat/slice2-attendance-engine`, stacked on `feat/slice1-employee-master-foundation` @ `5910819` |
| Worktree | **None.** Per `AGENTS.md` ("do not create Git worktrees") and the owner's Slice 1 decision. |
| PR #36 | Left **Draft and unmerged**; nothing pushed to it in this slice. |
| WIP | Untouched: `.ai/`, `AGENTS.md`, `.env.example`, `.gitignore`, `docs/SESSION_HANDOFF.md`, the vendor samples, blueprint, `docs/unified/00`–`05`, `docs/06a_*`, `docs/07_*`, `docs/MJU_SSO_INVESTIGATION_20261015.md`, `docs/SSO_VPS_DEPLOYMENT_AUDIT.md`. `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` intact. |
| Hosts | **Not contacted.** No SSH, no production DB, no deploy, no migration applied. |
| Redaction | No PII, secret, token, national ID or attendance row appears in this document or in any Slice 2 file. All examples use synthetic data. |
| Labels | **VERIFIED** (observed at the cited file/command), **REPORTED** (asserted elsewhere), **UNKNOWN** (no evidence). |

**Scope delivered:** backlog items **S1-A** (versioned attendance rules with effective dates) and **S1-B**
(`daily_attendance` provenance), i.e. the calculation engine, plus the Agent Core integration (Phase C).
No reports, no dashboards, no exports, no SSO change, no frontend.

## 1. Phase A — preflight findings

### 1.1 PR #36 and migrations 020/021 (VERIFIED)

PR #36 was `OPEN`, **Draft**, `mergeStateStatus: CLEAN`, base `integration/attendance-sso-hip`, **8/8 checks
green** including `backend-mariadb`. Migrations `020`/`021` therefore have throw-away-MariaDB evidence. Stale
documentation in the PR body and the Slice 1 doc was corrected in this slice (see §5).

### 1.2 Agent Core: the verified contract, and what it rules out (VERIFIED — read from source)

The task asked me to inspect the real adapter and the actual Gateway contracts and **not to guess endpoints**.
Read from `numtip/agent-core`:

* `src/projects.ts` declares `{ id: "rae-attendance-v2", type: "web-application", risk: "high",
  defaultScopes: ["decision"], notes: "…Agent assists planning and review only…" }`.
* `docs/STATUS.md`: "`rae-attendance-v2` is activated with scope **`decision` only**" and "No route, qa,
  context, metrics, or browser scope."
* The route table in `src/app.ts` applies a **per-route** scope guard.

| Route | Scope required | Available to this project |
|---|---|---|
| `POST /v1/decision` | `decision` | **yes** |
| `GET /v1/health` | none | yes |
| `POST /v1/route`, `/v1/subagent`, `/v1/subagent/complete`, `/v1/advanced-route` | `route` | **no — 403** |
| `GET /v2/capabilities`, `/v2/capabilities/:id`, `POST /v2/capabilities/search` | `route` | **no — 403** |
| `POST /v2/route`, `/v2/execute`, `/v2/rea/route` | `route` | **no — 403** |
| `POST /v1/qa` | `qa` | **no — 403** |
| `POST /v1/context`, `/v2/context/govern`, `/v2/knowledge/query` | `context` | **no — 403** |
| `POST /v2/browser/plan`, `/v2/browser/execute` | `browser` | **no — 403** |
| `GET /v1/projects`, `/v1/metrics`, `/v1/control-metrics`, `/control` | `metrics` / control auth | **no — 403/503** |

**Three consequences that shape Phase C:**

1. **`TASK_ROUTE` is NOT available.** `/v1/route`, `/v2/route` and the capability-discovery endpoints that
   would verify a route all require the `route` scope. Routing is out of reach for this project today, and
   `POST /v2/rea/route` is additionally **not deployed** (it exists only in `main` source).
2. **`QA_DISPOSITION` IS available — but only as a `decision_type`, not as a route.** `/v1/qa` needs the
   `qa` scope, yet the guard is on the *route*, not on the decision type. So `decision_type:
   "QA_DISPOSITION"` sent to `POST /v1/decision` is permitted. This distinction is the single most
   important thing found in preflight, and the adapter is built around it rather than around the
   adapter YAML.
3. **The adapter YAML is not a permission.** `.ai/jev.yaml` (and the agent-core copy) declares
   `task_route: true`, `qa_disposition: true`, `context_route: true`, `unified_route: true`,
   `gateway_execute: true`, `context_govern: true`, `supervisor: true`. The platform documents these as
   "declarative contracts, not runtime-enforced permissions" (STATUS.md known limitation 7). AGENTS.md and
   `.ai/policies.yaml` already say the activated scope is `decision` only; **the platform source agrees,
   and the YAML is the thing that is wrong.**

Also recorded: the deployed release is `0.7.0` (`dbe20a5`); `main` source is not deployed; `main` has no
retry loop and an 8 s provider timeout.

### 1.3 Credential availability (VERIFIED)

No `.env` exists in the workspace and none of `AGENT_CORE_URL`, `AGENT_CORE_PROJECT`,
`AGENT_CORE_PROJECT_TOKEN`, `AGENT_PLATFORM_URL`, `AGENT_PROJECT`, `AGENT_PROJECT_TOKEN` is set in the
environment. **A live gateway smoke test was therefore not possible** and was not attempted. The live-path
evidence in §4 is from injected-fetch contract tests, and that gap is stated rather than papered over.

## 2. Phase B — the attendance engine

Implemented backlog items S1-A and S1-B. Full policy contract: [`../ATTENDANCE_RULES.md`](../ATTENDANCE_RULES.md).

### 2.1 Versioned rules with effective dates (S1-A)

`attendance_rule_version` (migration `022`) stores the policy as **data**: work hours, `late_after`,
`early_before`, the working week, overnight support, a span guard, the holiday rule, and the leave/business
token lists — each with an effective window and an approval state. A `dbe20a5`-style config file is no
longer the source of truth for a stored number.

The donor's rule semantics are ported from `attendance-core` `engine.py` / `policy.py` (the only place they
were ever defined), with three donor defects fixed and each one covered by a test:

| Donor defect | Fix |
|---|---|
| No overnight support: a post-midnight check-out was always "left early" | `overnight_shift` on the rule; the departure frame shifts by 24 h; the shift is attributed to the day it **started**, so it is never counted twice |
| The holiday calendar lived in the *caller*, so a holiday row carrying clock times could still be flagged late | The calendar is an engine input (`attendance_holiday`, approved rows only) |
| Sorted by `int(employee_id)`, which throws on a non-numeric code | The engine never sorts or parses by employee code |

The engine **refuses** to judge a night shift's lateness, because no approved source defines an
overnight-relative threshold; it records the span and sets `overnightLatenessPolicyMissing`. That is
policy gap **P-03** in `ATTENDANCE_RULES.md`, not a silent assumption.

### 2.2 Provenance, status, idempotency (S1-B)

Migration `023` adds twelve columns to `daily_attendance` (`source_system`, `rule_version_code`,
`schedule_code`, `computation_status`, `day_classification`, `is_overnight`, `early_minutes`,
`source_event_count`, `first_event_at`, `last_event_at`, `calculated_at`, `reconciliation_json`), a
`UNIQUE(employee_uid, date)` key, and `daily_attendance_source_event`, which links a day to the exact
normalized scans it aggregated.

* **Idempotent:** upsert on `(employee_uid, date)`; the link set is **deleted and reinserted in the same
  transaction**, because a recalculation may legitimately use a different set of scans.
* **Deterministic:** the clock is passed in, not read; ordering is by full datetime; no randomness. The
  same inputs reproduce identical numbers — only `calculated_at`/`updated_at` move.
* **Historical ownership preserved:** scans are aggregated by the `employee_uid` stamped at ingest through
  the Slice 1 effective-dated mapping. Identity is never re-resolved, so an old period keeps its original
  owner after an employee code is reused (`employee-code reuse` test).
* **The `pending` status.** The pre-existing ENUM had `present/late/absent/leave/holiday` only. Rather than
  assert `present` or `absent` for a day we cannot judge, migration `023` adds `pending`. The enum widening
  is additive, and a CI test asserts the real column accepts it — which doubles as a migration-order check.

### 2.3 The honesty gate

`computation_status` is one of `calculated | no_data | insufficient_data | pending_policy | failed`, and
**only `calculated` carries lateness conclusions**. With no approved rule the day is `pending_policy` with
`late_minutes = 0`, `work_duration = 0` and `status = 'pending'`. The shipped fixture seeds the candidate
rule as `pending_approval`, so **a fresh install computes nothing** — by design. An API test asserts exactly
that against the running app.

### 2.4 API

| Method | Path | Notes |
|---|---|---|
| GET | `/attendance/daily-computed/:employeeUid/:date` | stored day + provenance |
| GET | `/attendance/daily-computed/:employeeUid` | stored range (`from`/`to`) |
| GET | `/attendance/explain/:employeeUid/:date` | recalculates **without storing**; reports why, incl. which rule is pending and whether the stored row is `stale` |
| POST | `/attendance/recalculate` | manager/admin; deterministic, idempotent |
| POST | `/attendance/recalculate/:employeeUid` | same, scoped to the path employee |

All five are documented in `docs/API_CONTRACT.md`, so `npm run contract:smoke` now exercises them (22 paths,
up from 17). Authorization reuses the existing model; **role alone never widens data scope** — an admin
without an explicit `authorization_grants` row cannot recalculate another employee's record, and a test
asserts the 403.

## 3. Phase C — Agent Core integration

The existing `agent/` adapter was **extended, not duplicated**. No second gateway, no new client, no new
dependency. `agent/agentCoreClient.js`, `decisionSchema.js` and `policy.js` were left untouched.

| Requirement | Implementation |
|---|---|
| Reuse the existing adapter | `agent/decisions.js` now resolves config through the new `agent/config.js`; every previous export and behaviour is preserved |
| Accept both env naming schemes | `AGENT_CORE_URL`/`AGENT_CORE_PROJECT`/`AGENT_CORE_PROJECT_TOKEN` **or** `AGENT_PLATFORM_URL`/`AGENT_PROJECT`/`AGENT_PROJECT_TOKEN` (legacy names win, so existing deployments do not shift) |
| Use only supported capabilities | `agent/capabilities.js` encodes the verified scope (`decision`), the full `UNAVAILABLE_ENDPOINTS` list and `assertSupportedPath()`, which throws for anything outside `/v1/decision` and `/v1/health` |
| Small opt-in local CLI | `agent/cli.js` — `doctor`, `decide`, `probe`; exit 0/1/2; no new dependencies; no network needed for `doctor`/`probe` |
| Strict response schema | The pre-existing `normalizeAgentCoreResponse` (rejects a bad `disposition`, a missing `result`, an out-of-range `confidence`) is unchanged and still the only way a response is accepted |
| Never execute privileged actions from an AI decision | `agent/policy.js` `assertAllowedDecisionRequest` (forbidden intents) and `applyApprovalGate` (forces `requires_human_approval` for `REVIEW`/`FALLBACK`/high risk) are unchanged |
| Timeout, bounded retry, deterministic fallback | Pre-existing 15 s timeout + `maxRetries: 1`; `createFallbackDecision` returns a `FALLBACK` that **requires human approval**; the CLI returns it when unconfigured and exits 0 |
| Never send PII to Agent Core | `agent/sanitize.js`: `FORBIDDEN_PAYLOAD_KEYS` (names, e-mails, national/personnel/facescan/employee ids, tokens, cookies, rows, raw logs), `sanitizeContext()` with depth/length/array bounds, cycle handling and a **path-only** redaction list, plus `assertNoSensitiveContent()` which rejects a surviving forbidden key or a JWT/email/13-digit-run **string** and names only the key path |
| Offline contract + mocked tests | `agent/tests/agentBoundary.test.js`, no network |
| Optional live smoke with existing credentials | **Not run** — no credentials exist locally (§1.3) |
| Static checks for this folder | `agent/eslint.config.js` added: `agent/` is a separate package and had **no** ESLint config, so none of this code was linted. The rules mirror `backend/eslint.config.js`. Running it surfaced one genuine finding (an unused `AgentCoreError` import in the pre-existing `agent/tests/decisions.test.js`, now removed) and two `require-atomic-updates` false positives on intentional patterns (`process.exitCode` at the end of `main()`, and a test's `finally` restore), which is why that rule is explicitly not enabled here. **See §6 item 8: CI still does not enforce it.** |

**Boundary guarantee under test:** a fake `fetch` records every URL the decision path calls, and the test
asserts every one ends with `/v1/decision`. The unsupported endpoints are data (`UNAVAILABLE_ENDPOINTS`),
not prose, and each is asserted.

**Agent Core can never block attendance.** The advisory hook in `dailyAttendanceService.requestAdvisory()`
is optional, is not required for a result, and swallows a failure into `{ available: false, reason, code }`.
A test injects a failing advisory, asserts the calculation still completes **and** that the stored number is
unchanged. A second design point: the Express runtime does **not** import `agent/` at all — that folder is
documented as agent-only, so the advisory is injected through the container and defaults to `null`.

## 4. QA evidence

All commands run on this host on 2026-10-15.

| Check | Command | Result |
|---|---|---|
| Backend lint | `cd backend && npm run lint` | **PASS** (exit 0) |
| Backend suite | `cd backend && JWT_SECRET=… npm test` | **PASS** — `335 tests, 326 pass, 0 fail, 9 skipped` |
| Engine unit tests | `node --test tests/dailyAttendanceCalculation.test.js` | **PASS** 31/31 |
| Slice 2 integration | `node --test tests/slice2AttendanceCalculation.test.js` | **PASS** 13/13 |
| Rule module | `node --test tests/attendanceRule.test.js` | **PASS** |
| Daily repo module | `node --test tests/dailyAttendance.test.js` | **PASS** |
| Agent boundary | `cd agent && node --test tests/agentBoundary.test.js tests/decisions.test.js` | **PASS** 43/43 (the pre-existing suite still passes) |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS** — 22 API_CONTRACT paths (was 17) |
| Onboarding suite | `npm run onboarding:test` | **PASS** 23/23 |
| Frontend regression | `cd frontend && npm run build` | **PASS** |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS** |
| CLI behaviour | `node agent/cli.js doctor \| decide \| probe --path /v1/route \| bogus` | **PASS** — `doctor` prints a token-free summary; `probe` reports `AGENT_CORE_UNSUPPORTED_ENDPOINT`; `decide` returns a deterministic `FALLBACK` with exit 0; a bad subcommand exits 2 |
| PII review of every Slice 2 file | ripgrep for 13-digit runs and e-mail addresses | **PASS** — only synthetic `*@example.test` and the repo's existing synthetic `99…` constants |
| No CSV / `database/local/` read | tool-call review | **PASS** — header names, paths, row counts only |
| No host contact | tool-call review | **PASS** |

**Mutation evidence** (each reverted afterwards):

* Disabling the night-shift lateness suppression (`if (isOvernightShift)`) → the `P-03` assertion fails: the
  night shift becomes `late` with 810 minutes. The policy gap is therefore **enforced**, not merely
  documented.
* Slice 1 precedent, still valid: disabling the identifier validity check fails 6 tests including the
  ingestion assertion.

**A correction, recorded rather than quietly dropped.** During development the tests genuinely caught a
midnight-ordering defect: the scans were sorted by time-of-day, so a `22:00` arrival and a `06:00`
next-morning departure were swapped and a night shift read as "present". The fix was twofold — order by full
datetime, **and** partition the scans by calendar day so a shift's departure is carried over explicitly.
Re-testing the mutation now shows that the *partition* alone is what makes it correct: reverting the sort to
time-of-day no longer fails any test, because the carry-over set is concatenated after the same-day set. So
the datetime sort is **defensive, not load-bearing**, and this document does not claim a mutation proves it.
The behaviour is still covered by tests (`an overnight shift is not misreported as an early departure`, and
the two "counted once" tests); only the *mutation* claim was wrong.

### 4.1 Independent verification pass and the defects it found

A separate verifier agent was asked to falsify §1–§4. It reproduced the lint and suite numbers, confirmed
the honesty gate held at every branch (no non-`calculated` path produces a number), confirmed determinism
and the idempotent link replacement, and then found two **blockers** plus two important issues. **All four
were fixed, each with a regression test.**

| # | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| 1 | **blocker** | `groupEventsByDate` keyed the day with `String(event.eventTime).slice(0, 10)`. MariaDB returns a **`Date`** for `event_time`, so the key became `"Thu Sep 10"`, matched no ISO date, and **every recalculated day was stored `absent` with zero provenance**. This is the same class of bug that broke Slice 1's CI, and the repo's own MariaDB test would have failed on it. | Use the existing `wallDateOnly()` helper, exactly as the engine already does. | `a Date-shaped eventTime is grouped by its wall date` (feeds real `Date` values), `groupEventsByDate reads a Date and a string to the same day` |
| 2 | **blocker** (authorization) | `POST /attendance/recalculate` with no `employeeUid` skipped the scope check entirely and rebuilt — and returned — **every** employee with scans. Any manager or admin could read the whole organization's attendance by omitting a parameter, falsifying §2.4's scope claim. | Resolve the caller's data scope and require `all`/`broad`; otherwise 403. Restrict an org-wide run to the resolved scope's UIDs. | `an organization-wide recalculation requires a broad data scope`, `a broad scope may run an organization-wide recalculation`, `an executive with a broad grant is read-only for recalculation` (3 new tests) |
| 3 | important | Overnight support was **unreachable through the service**: `calculateDay` loaded only `[date, date]` and `recalculateRange` passed only that day's scans, so the engine's carry-over set was always empty and a night shift stored `insufficient_data` on both days. The documented night-shift example was true only for the pure-engine unit test. | Widen the scan window to `[date, date + 1]` in both call paths, and pass the next day's scans to the engine (which ignores them unless the rule enables overnight). | `an overnight shift is reachable through the service, not only the pure engine` |
| 4 | important | The "no PII leaves the process" claim was enforced only in the CLI: `decide()` passed the caller's context straight into the request, so `employeeUid`/`nationalId` reached Agent Core verbatim. `sanitizeContext` and `assertNoSensitiveContent` were also **not composable** — the documented sequence always threw on a redacted key. | Sanitize **and** assert inside `decide()`, the single decision path; make the assertion skip keys already redacted. | `the decision path sanitizes the caller context before it leaves the process`, `…refuses a context that still looks like a credential`, `sanitizeContext and assertNoSensitiveContent compose` |

Also fixed from that pass: `explain.stale` compared timestamps (so it was always `true` and meant nothing)
and now compares the **decision** fields; the hardcoded 960-minute span guard is now **flagged** like the
working-week default; and the `023` rollback documents that it deliberately does **not** narrow the `status`
ENUM back, with the exact statement to run if that is ever wanted.

Two things the verifier flagged are **accepted as-is** rather than "fixed": the `DEFAULT_WORK_DAYS` Mon–Fri
fallback is a deliberate, flagged default (`workDaysDefaulted`), and the `960` guard only ever *refuses* a
result, never fabricates one.

**On the verification pass itself:** the verifier could not run the MariaDB suite (no Docker locally) and
said so; it also listed four behaviours claimed but untested, three of which are now covered by the tests
above. This is the second slice in a row where an independent pass found a defect the author's own tests had
missed, and in both cases it was a `Date`-versus-string assumption. That pattern is now a standing hazard
recorded in `08_MIGRATION_DEPENDENCY_GRAPH.md` §4.

**MariaDB CI:** migrations `001`–`023` are applied to a throw-away MariaDB 11.4 by the `backend-mariadb`
job, which then runs `backend/tests/slice2.mariadb.test.js`. That suite asserts the migration `022`/`023`
DDL, the real `DATETIME` round-trip (`mysql2` returns a `Date`, which is exactly the hazard that broke
Slice 1's CI), the transactional upsert and link replacement, the approval `CHECK`, holiday scope, and the
new `pending` ENUM value. **This is the verification of the DDL.** The job is the reason Slice 1 shipped a
real fix, and it is treated here as authoritative rather than as a formality.

**Synthetic calculation examples** (fixture rule approved for illustration; threshold `08:30`–`16:30`):
| Case | Scans (synthetic) | Result |
|---|---|---|
| On time | `08:00` in, `17:00` out | `calculated` / `present`, `late=0`, `early=0`, `work_duration=9`, 2 source events |
| Late | `08:45` in, `16:30` out | `calculated` / `late`, `late_minutes=15`, `work_duration=7.75` |
| Early departure | `08:30` in, `15:30` out | `calculated` / `present`, `early_minutes=60` (08:30 exactly is **not** late) |
| Duplicate scan | `08:00`, `08:00` (same second+type), `17:00` | `duplicateScanCount=1`, `sourceEventCount=2`, ids `[1,3]` |
| Night shift | `22:00` in, `06:00` next day out | `overnight=true`, `work_duration=8`, `overnightLatenessPolicyMissing=true`, **no** late/early claim |
| Working day, no scans, no leave | — | `no_data` / `absent`, all minutes 0 |
| Only one scan | `08:00` in | `insufficient_data` / `pending`, reason `single_scan_only` |
| Implausible span | `06:00` in, `23:00` out, max 600 min | `insufficient_data` / `pending`, reason `span_exceeds_max`, no duration recorded |
| Leave | verified `employee_leave` row | `calculated` / `leave`, `leave_type` taken from the leave row |
| Holiday | approved university holiday | `calculated` / `holiday`, lateness never evaluated |
| No approved rule | any | `pending_policy` / `pending`, `late=0`, `work_duration=0`, rule not recorded |
| Foreign scan | a scan attributed to another employee | excluded, `foreignEventsExcluded=true`, the other employee's id never appears in the output |

## 5. Documentation and corrections made in this slice
* New: [`../ATTENDANCE_RULES.md`](../ATTENDANCE_RULES.md) — the rule contract, the honesty gate, the
  precedence order, the verified-leave rule, and the eight **open policy questions** (P-01…P-08).
* New: [`08_MIGRATION_DEPENDENCY_GRAPH.md`](08_MIGRATION_DEPENDENCY_GRAPH.md) — the ordered dependency
  table for `001`–`023`, the deliberate prefix collisions, the runner's filename-keyed ledger, and the
  four deploy-order constraints.
* Updated: `docs/API_CONTRACT.md` — the five new routes (which is what makes `contract:smoke` cover them).
* Corrected: the Slice 1 doc's claim that the code works without migration `020` (it does not), the
  `column_map_json` provenance semantics, and the PR #36 body (via the Slice 1 fix commit).
* Recorded: the adapter YAML is declarative and does **not** grant the `route`/`qa` scopes that Phase C was
  asked to integrate against (§1.2).

## 6. Unresolved, and out of scope

1. **No rule is approved.** `AR-0001` is `pending_approval`, so every calculation is `pending_policy` until
   an owner supplies `approved_by`/`approved_at`. This is the gate, not a bug.
2. **Eight open policy questions** (P-01…P-08 in `ATTENDANCE_RULES.md`), the most consequential being the
   night-shift lateness definition (P-03), the working week (P-02) and whether Thai remark tokens still
   create leave (P-07).
3. **No holiday data.** The calendar table exists and is empty; importing a real calendar needs an approved
   source.
4. **No `monthly_summary` writer.** Slice 2 computes and stores days only.
5. **The donor Python Attendance Core is still reachable** via the pre-existing `/attendance/evaluate-*`
   proxy routes. It is now redundant for daily calculation, and retiring it is a separate decision —
   removing it would change an existing API contract.
6. **Live Agent Core was never contacted.** No credentials locally; the Gateway scope map is verified from
   source, not by probing. Backlog item S2-G covers a one-credential live smoke.
7. **The `agent/` folder is still not linted by CI.** `agent/eslint.config.js` now exists and the folder
   lints clean, but the `agent-core` CI job runs `npm test` only. Enforcing lint needs an `eslint`
   devDependency **and a lockfile** for that package (it has neither, and no `node_modules`), which is a
   build-system change that should not be smuggled into a feature slice. Tracked as item 8 below.
8. **Carried-over blockers, untouched:** `D-01` employee-master source, `D-02` legacy DB recovery, `D-04`
   HIP ID evidence, `D-06` MJU `ac` semantics, `DT-03` the pre-`013` ledger gap, and the `S-01`–`S-13`
   security items.

## 7. Next-slice backlog (proposal only)

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| S2-A | Obtain owner approval for `AR-0001` (or a corrected policy), with `approved_by`/`approved_at` | S | P-01, P-02 | An operator can see a real `late`/`present` result for a synthetic fixture; no rule value is invented by an agent |
| S2-B | Define and implement a night-shift lateness rule | M | P-03 | `overnightLatenessPolicyMissing` disappears only when an approved threshold exists; a golden test pins it |
| S2-C | `monthly_summary` writer derived from `daily_attendance`, with the same provenance discipline | M | S2-A | Totals reconcile to the daily rows; a month is reproducible from its rule versions |
| S2-D | Holiday calendar import (approved source only) with checksum and owner | M | P-05, P-06 | Import is idempotent; unrelated department holidays are not applied |
| S2-E | Employee-scoped schedule onboarding (approved only) | M | P-02 | A pending schedule is reported, never applied; tests cover the boundary |
| S2-F | Retire the donor Attendance Core proxy routes behind a documented contract change | M | — | The contract change is documented and announced; no consumer breaks silently |
| S2-G | Verify the live Gateway decision path with one consenting credential (read-only smoke) | S | credentials | One `NEXT_ACTION` and one `QA_DISPOSITION` decision, secret never printed |
| S2-H | Add an `eslint` devDependency + lockfile to the `agent/` package and enforce `eslint .` in the `agent-core` CI job | S | — | CI fails on a lint error in `agent/`; the missing lockfile is resolved deliberately, not by an unpinned `npx` |
| S2-I | Leave-remark classification as an opt-in, owner-approved policy token set | M | P-07 | Tokens come from an approved rule version, not a hardcoded list; false-positive cases tested |

## 8. Review checklist

- [ ] Migration numbering `022`/`023` accepted (or renamed **before** any apply).
- [ ] The `pending` status addition to `daily_attendance.status` accepted.
- [ ] The honesty gate accepted: an unapproved rule produces `pending_policy`, never an estimate.
- [ ] The Agent Core finding accepted: `TASK_ROUTE` is **not** available to this project; `QA_DISPOSITION`
      is usable only as a `decision_type` on `/v1/decision`.
- [ ] The eight open policy questions are accepted as owner decisions, not engineering defaults.
- [ ] `backend-mariadb` CI green on the Slice 2 PR.
- [ ] Approval to push `feat/slice2-attendance-engine` and open a **Draft** PR stacked on PR #36.
