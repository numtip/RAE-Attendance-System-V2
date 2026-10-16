# Daily summary — 2026-10-15 (Asia/Bangkok)

**Scope of the day:** complete Slice 1 and Slice 2 of the RAE Attendance Unified Platform, verify both
independently, and publish them as stacked Draft PRs. No production operation of any kind.

**Label legend:** **VERIFIED** = observed in this session at the cited command/evidence · **REPORTED** =
asserted by a document or another operator · **UNKNOWN** = no evidence.

## 1. What shipped

| Deliverable | Branch | Tip SHA | PR | State |
|---|---|---|---|---|
| Slice 1 — effective-dated employee master + attendance data foundation | `feat/slice1-employee-master-foundation` | `5910819` | [#36](https://github.com/numtip/RAE-Attendance-System-V2/pull/36) | OPEN, **Draft**, 8/8 CI green (VERIFIED) |
| Slice 2 — versioned attendance engine + Agent Core decision-only integration | `feat/slice2-attendance-engine` | `d279bba` | [#37](https://github.com/numtip/RAE-Attendance-System-V2/pull/37) | OPEN, **Draft**, 8/8 CI green (VERIFIED) |

Both PRs are **Draft and unmerged** (`mergedAt: null`, `mergeStateStatus: CLEAN`) — VERIFIED via
`gh pr view 36/37`. Nothing was merged, retargeted, force-pushed or reset.

## 2. Slice 1 — employee master + attendance data foundation

Seven commits from `7d810d8`, of which three are Slice 1's own:

| SHA | What |
|---|---|
| `d777fe4` | `employee_assignment` (effective-dated employment attributes), identifier validity window, CSV/FaceScan ingestion adapter, one new authenticated route |
| `3841424` | fixes for four defects found by an independent verifier |
| `5910819` | fix for a defect **CI** found (Date-vs-string) |

Delivered: employee code / department / position / employee_type over inclusive `effective_from`/`effective_to`
intervals, with overlap and employee-code-conflict rejection enforced in a transaction; a validity window on
`employee_identifier` so ingestion resolves a scan through the mapping **effective on the scan date**; a CSV
adapter that delegates validation/dedup/idempotency to the existing ingest; and file provenance
(`file_name`, `input_sha256`, `parser_version`, `column_map_json`).

Migrations: **`020`**, **`021`**.

## 3. Slice 2 — versioned attendance engine + Agent Core

Four commits, stacked on Slice 1:

| SHA | What |
|---|---|
| `d12e381` | versioned rules (`022`), provenance + idempotency (`023`), the pure calculation engine, 5 routes, Agent Core adapter extension |
| `c785ffb` | fixes for **two blockers** and two important defects found by an independent verifier |
| `8e33d92` | fix for an FK-ordering defect **CI** found in the new MariaDB test cleanup |
| `d279bba` | the missing ESLint config for the `agent/` package |

Migrations: **`022`** (`attendance_rule_version`, `attendance_holiday`, `attendance_schedule`),
**`023`** (twelve provenance columns on `daily_attendance`, `UNIQUE(employee_uid, date)`,
`daily_attendance_source_event`, `status` gains `pending`).

**The headline property:** an **unapproved** rule never produces a number. The shipped fixture seeds the
candidate rule as `pending_approval`, so a fresh install computes nothing and every day reports
`pending_policy`. Night-shift lateness is withheld because no approved source defines an overnight threshold,
and that gap is flagged rather than guessed.

## 4. The two verification passes (and what they caught)

Both slices were reviewed by a **separate verifier agent** told to falsify the author's claims. In both
cases the verifier found real defects that the author's own tests had missed, and in both cases the root
cause was the same assumption.

| Found by | Severity | Defect |
|---|---|---|
| Verifier, Slice 1 | important ×4 | `reResolveUnmapped` ignored the mapping window (falsified the slice's headline guarantee); `closeAssignment` could create overlapping windows; fixture/MariaDB disagreed on an unknown employee; a `Date`-shaped `onDate` failed open |
| **CI**, Slice 1 | blocker | `String(row.checkTime).slice(0, 10)` — the fixture returns a string, MariaDB returns a `Date`, so it produced `"Tue Mar 0"` and **every** re-resolve against a real database failed |
| Verifier, Slice 2 | **blocker ×2** | `groupEventsByDate` used the same `String(...).slice(0,10)` pattern → **every recalculated day was stored `absent` with zero provenance**; and the unscoped `recalculate` route let any manager/admin rebuild and read the whole organisation |
| Verifier, Slice 2 | important ×2 | overnight support was unreachable through the service; the "no PII leaves the process" rule was enforced only in the CLI |
| **CI**, Slice 2 | important | the new MariaDB test deleted `attendance_events` before the link rows referencing them |

**Standing lesson, now recorded in `docs/unified/08_MIGRATION_DEPENDENCY_GRAPH.md` §4:** the
fixture/MariaDB twin pattern **hides `Date`-versus-string divergence** from local tests. Any code formatting
a stored date must use `wallDateOnly()` / `splitWallDateTime()`, never `String(value).slice(0, 10)`. This
has caused a defect in two consecutive slices, and the `backend-mariadb` CI job is the only check that
catches it.

## 5. QA evidence (all VERIFIED on this host)

| Check | Result |
|---|---|
| Backend lint (`cd backend && npm run lint`) | clean |
| Backend suite | **342 tests, 333 pass, 0 fail, 9 skipped** |
| Agent suite (`cd agent && node --test tests/*.test.js`) | **46/46** |
| Agent lint (`agent/eslint.config.js`, new today) | clean |
| Contract smoke | **22** API_CONTRACT paths (was 17) |
| Onboarding suite | 23/23 |
| Frontend build | pass |
| Secret scan | pass |
| CI on #36 and #37 | **8/8 green**, including `backend-mariadb` |

The `backend-mariadb` job applies migrations `001`–`023` to a throw-away MariaDB 11.4 and then runs the
suite. It is the **DDL verification** and the only `Date`/string parity check; it caught a real defect in
each slice.

**Not verified (stated rather than assumed):** the migrations were never applied to a database on this
host (no Docker/MariaDB present), never to a populated database, and no apply order is proposed. No live
Agent Core call was made — no credentials exist locally.

## 6. Agent Core outcome

Preflight established the boundary from the `numtip/agent-core` **source** (VERIFIED), not by probing:

* `src/projects.ts` grants `rae-attendance-v2` scope **`decision` only**; `docs/STATUS.md` agrees.
* The guards in `src/app.ts` are **per-route**, so **`TASK_ROUTE` is NOT available** (`/v1/route`,
  `/v2/route`, `/v2/capabilities` all require `route`; `/v1/qa` requires `qa`).
* **`QA_DISPOSITION` IS usable — but only as a `decision_type` on `/v1/decision`**, because the guard is on
  the route and not on the decision type.
* `.ai/jev.yaml` claims `task_route: true`, `qa_disposition: true`, `gateway_execute: true`… The platform
  documents adapter YAML flags as **declarative contracts, not runtime permissions**. The YAML is what was
  wrong; `AGENTS.md` and `.ai/policies.yaml` were right.

Implemented: sanitization + capability guards in the single decision path, a dependency-free opt-in CLI
(`doctor` / `decide` / `probe`), bounded timeout/retry, and a deterministic `FALLBACK` that requires human
approval. The Express runtime does **not** import `agent/`; the advisory is container-injected and optional,
and a test injects a failing advisory and asserts the stored number is unchanged — **an Agent Core outage
cannot block or alter a calculation**.

## 7. Documentation produced

| File | Purpose |
|---|---|
| `docs/unified/06_SLICE1_EMPLOYEE_MASTER_AND_ATTENDANCE_FOUNDATION.md` | Slice 1 review artefact |
| `docs/unified/07_SLICE2_ATTENDANCE_ENGINE.md` | Slice 2 review artefact |
| `docs/unified/08_MIGRATION_DEPENDENCY_GRAPH.md` | Ordered dependencies `001`–`023`, deploy-order constraints, the `Date`/string hazard |
| `docs/ATTENDANCE_RULES.md` | Rule contract, the honesty gate, and **eight open policy questions** |
| `docs/API_CONTRACT.md` | Updated with the five Slice 2 routes (which is what makes `contract:smoke` cover them) |
| `docs/memory/*` (this set) | Durable project memory for continuation |

## 8. Deliberate non-actions

* Nothing merged, retargeted, force-pushed, reset or cleaned. **PR #36 and #37 stay Draft.**
* No production contact: no SSH, no deploy, no migration on real data, no config or secret change.
* Pre-existing WIP preserved untouched (18 entries, 2 stashes) — see `PROJECT_STATE.md` §4.
* `docs/SESSION_HANDOFF.md` **not** modified, because it carries pre-existing uncommitted WIP belonging to
  an earlier session. `PROJECT_STATE.md` supersedes it for current status; updating the handoff is pending
  owner approval (see `NEXT_ACTIONS.md`).
