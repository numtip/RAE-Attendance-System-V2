# DECISIONS — RAE Attendance System V2

Decisions taken while building Slice 1 and Slice 2 (2026-10-15), with the reasoning that makes them
reviewable. Owner-level decisions that are still **open** are listed separately in §3 — nothing there was
silently resolved by an agent.

**Label legend:** **VERIFIED** · **REPORTED** · **UNKNOWN** (as used throughout `docs/unified/`).

---

## 1. Decisions that were approved by the owner

| # | Decision | Consequence |
|---|---|---|
| D-A | **Slice 1 isolation: in-place feature branch, no git worktree.** `AGENTS.md` forbids new worktrees while the blueprint and the initial task text suggested one (conflict X-01). | One worktree only; conflict X-01 stays open at owner level. Recorded in `docs/unified/06` §0. |
| D-B | **Slice 1 scope = schema + contracts + ingestion foundation only** — no attendance rule math. | Rule math became Slice 2 instead of being crammed into Slice 1. |
| D-C | **Push the slice branches and open Draft PRs; no merge.** | PRs #36 and #37 are Draft; `main` untouched. |
| D-D | **Do not edit `docs/SESSION_HANDOFF.md`** (it carries another session's uncommitted WIP). | Slice status lives in `docs/unified/06`/`07` and `docs/memory/`; updating the handoff is pending. |

## 2. Engineering decisions made during Slice 1 / Slice 2

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E1 | **Effective-dating via an interval table, not a history/audit table.** `employee_assignment` holds one row per validity interval. | Lets a past period be recomputed with the data true then. The versioned-rule rationale is the same. | `06_SLICE1…` §2.2 |
| E2 | **Overlap and employee-code-conflict rejection is enforced in a repository transaction with `FOR UPDATE`**, not only in the service. | A service-only check can be bypassed by a concurrent writer. | `06_SLICE1…` §2.2 |
| E3 | **One validity window per identifier value; a value never moves between employees.** | The security-critical `UNIQUE(id_type, id_value)` and the migration-017 namespace triggers were left untouched rather than weakened to support re-assignment. Deliberate limitation. | `06_SLICE1…` §2.3 |
| E4 | **A closed/open validity window uses two nullable DATE columns with `NULL` = "no bound", and `onDate = null` = "do not filter".** | Preserves the exact pre-`020` behaviour for callers that do not care about history (notably the SSO national-ID lookup). | `06_SLICE1…` §2.3 |
| E5 | **CSV ingestion delegates to the existing `ingestCheckinoutBatch`** instead of reimplementing validation/dedup. | Keeps one owner for validation, dedup and idempotency; the adapter only adds file parsing, a header contract and provenance. | `06_SLICE1…` §1.1 |
| E6 | **The CSV header map is a CANDIDATE, overridable contract.** | The real HIP export headers are unverified (`HIP_ID_FIELD_UNVERIFIED`). Inventing a confirmed-looking contract would be a fabrication. | `06_SLICE1…` §5.3 |
| E7 | **Migration numbering `020`/`021`/`022`/`023`, skipping `018`/`019`.** | Draft PR #35 already claims `018`/`019`, and the ledger keys on the filename, so this keeps both branches applicable in either merge order. | `08_MIGRATION_DEPENDENCY_GRAPH.md` §3 |
| E8 | **Every new migration is `information_schema`-guarded and idempotent, with a rollback file.** | DDL auto-commits and the ledger has no checksum, so a partial failure can only be repaired by re-running the same file. | `08_…` §1 |
| E9 | **Versioned rules as DATA (`attendance_rule_version`), not a config file.** | A stored number must be able to name the rule that produced it, and a past period must be reproducible. | `07_SLICE2…` §2.1 |
| E10 | **The honesty gate: an unapproved rule produces `pending_policy` with zero minutes, never an estimate.** `late_minutes`/`early_minutes`/`work_duration` are non-zero only when `computation_status = 'calculated'`. | An attention system must not assert an absence or a lateness it cannot prove. | `ATTENDANCE_RULES.md` §2 |
| E11 | **`status` gains a `pending` value (migration `023`).** | Without it the only options for "facts known, judgement impossible" would be `present` or `absent` — both assertions. This is an additive ENUM widening. | `07_SLICE2…` §2.2 |
| E12 | **Night-shift lateness is WITHHELD, not invented.** The span is recorded; lateness and early departure are flagged `overnightLatenessPolicyMissing`. | No approved source defines an overnight-relative threshold. This is open policy question **P-03**. | `ATTENDANCE_RULES.md` §6 |
| E13 | **Leave comes from verified `employee_leave` rows, not from Thai remark text.** | The donor's substring matcher (alias `ลา`) produces false positives. Porting it needs an owner decision (**P-07**). | `ATTENDANCE_RULES.md` §4 |
| E14 | **The engine never re-resolves identity.** It aggregates `attendance_events` by the `employee_uid` stamped at ingest. | Preserves historical ownership after an employee code is reused; a scan is never silently re-attributed. | `07_SLICE2…` §2.2 |
| E15 | **Idempotency via `UNIQUE(employee_uid, date)` plus delete-then-reinsert of the source-event links in one transaction.** | A recalculation legitimately references a different event set, so the links must be replaceable — and a failed link write must not leave a row claiming provenance it lacks. | `07_SLICE2…` §2.2 |
| E16 | **The clock is passed into the calculation (`calculatedAt`), never read inside it.** | Determinism: the same stored inputs reproduce identical numbers, which is what makes a historical report defensible. | `07_SLICE2…` §2.2 |
| E17 | **The Express runtime does NOT import `agent/`; the advisory is container-injected and optional.** | `agent/` is documented as agent-only, and an Agent Core outage must never block or alter a core calculation. | `07_SLICE2…` §3 |
| E18 | **Agent Core integration is restricted to `POST /v1/decision`.** `TASK_ROUTE` is unavailable (scope `route` is not granted); `QA_DISPOSITION` is used only as a `decision_type`, because the guard is per-route. | Verified from the `agent-core` source, not assumed, and encoded as data (`UNAVAILABLE_ENDPOINTS`) with a test asserting every call goes to `/v1/decision`. | `07_SLICE2…` §1.2 |
| E19 | **Sanitization and the sensitive-content assertion live inside `decide()`, the single decision path.** | Enforcing them only in the CLI let `employeeUid`/`nationalId` reach Agent Core verbatim. A boundary that can be bypassed is not a boundary. | `07_SLICE2…` §4.1 |
| E20 | **`agent/eslint.config.js` added, but lint was NOT wired into CI.** | The folder had no config at all. Enforcing lint needs an `eslint` devDependency **and a lockfile** for that package; reaching for `npx eslint@latest` would put an unpinned registry fetch in CI. Deferred as **S2-H** rather than faked. | `07_SLICE2…` §6 item 7 |
| E21 | **`explain.stale` compares decision fields, not timestamps.** | `calculatedAt` necessarily differs on a fresh run, so the original comparison was always `true` and meaningless. | `07_SLICE2…` §4.1 |
| E22 | **Two verification passes were commissioned and their findings fixed before push.** Six defects in total, two of them blockers. | In both slices the verifier found something the author's tests had missed. | `07_SLICE2…` §4.1 |

## 3. OPEN owner decisions (do NOT treat as engineering defaults)

### 3a. Attendance policy — the engine is blocked on these

| # | Question | Current behaviour while unresolved |
|---|---|---|
| P-01 | Are the work hours `08:30–16:30` correct per employee type? | `AR-0001` stays `pending_approval`; every day reports `pending_policy` |
| P-02 | Is the working week Mon–Fri for everyone, and do any units differ? | Schedule-overridable; a missing value falls back to Mon–Fri **and is flagged** |
| **P-03** | **How is lateness defined for a night shift?** | Span recorded; lateness/early departure **withheld** and flagged |
| P-04 | Are `late_after`/`early_before` grace periods, with any rounding rule? | Exact comparison, boundary inclusive |
| P-05 | Which holiday scope applies (national / university / department)? | All three supported; only `approved` rows count; calendar is empty |
| P-06 | Is a `department` holiday inherited by sub-units? | Exact `org_unit_code` match only; no hierarchy assumed |
| P-07 | Do Thai remark tokens (`ป่วย`, `พักผ่อน`, …) still create leave? | No — verified `employee_leave` rows only |
| P-08 | Which wins when an approved schedule and a rule disagree? | The schedule wins for that employee, and its code is stored as provenance |

Approving a rule requires `approved_by` **and** `approved_at`; a database `CHECK` enforces it, so an
untraceable approval cannot be written.

### 3b. Platform and data decisions still open

| # | Decision | Status |
|---|---|---|
| D-01 | Which populated source is the authoritative employee master? | **open** — `employee_assignment` has no source of truth loaded |
| D-02 | Recover the legacy `attendance_db`, or declare it out of scope? | **open** |
| D-04 | Is CSV `Facescan Code` really the HIP `facescan_id`? | **open** — gate stays closed |
| D-05 | Authoritative attendance source per day | **open** |
| D-06 | What is `ac` (lifetime, single-use, binding, signing)? | **open** — MJU IT has not answered |
| D-07 | Live host gate values (`SSO_ENABLED`, `DATA_SOURCE`) | **UNKNOWN** — never read |
| D-09 | Which host runs the unified production runtime | **open** |
| D-10 | Who approves HR / executive data scope | **open** |
| X-01 | Blueprint worktrees vs `AGENTS.md` "no worktrees" | **open** — resolved in practice by D-A (no worktree), rule unchanged |
| HY-1 | Delete the stale local branch `feat/attendance-core-service` (2 local-only, superseded commits)? | **open** — evidence in `PROJECT_STATE.md` §4a; needs explicit approval |
| HY-2 | Refresh `docs/SESSION_HANDOFF.md` with the Slice 1/2 status? | **open** — it carries another session's WIP |

## 4. Decisions explicitly NOT taken (and why)

* **Retiring the donor `attendance-core` Python service.** Its `/attendance/evaluate-*` proxy routes still
  exist. It is now redundant for daily calculation, but removing it changes a published API contract, so it
  is a separate, documented decision (backlog S2-F).
* **Porting the Thai leave-remark classifier.** Needs **P-07** first.
* **Writing to `daily_attendance` from a rule the owner has not approved**, or auto-promoting `AR-0001`.
* **Applying any migration to a real database.** The live ledger is pre-`013`; no apply order exists.
* **Deleting or editing any stash, backup or pre-existing WIP.**
