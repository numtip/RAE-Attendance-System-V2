# PROJECT_STATE — RAE Attendance System V2

**As of:** 2026-10-15 (Asia/Bangkok), **updated 2026-10-16** for Slice 4 / R-02 (§1, §2, §3, §6 R9).
**Supersedes** `docs/SESSION_HANDOFF.md` for current status.
That file still holds the pre-Slice handoff and carries uncommitted WIP, so it was deliberately left
untouched — see §7.

**Label legend:** **VERIFIED** = observed at the cited command · **REPORTED** = asserted elsewhere · **UNKNOWN** = no evidence.

---

## 1. Branch and SHA map (VERIFIED, 2026-10-15)

```
origin/main                              3244553
  └─ integration/attendance-sso-hip      7d810d8   (base of PR #36)
       └─ feat/slice1-employee-master-foundation   5910819   PR #36  Draft
            └─ feat/slice2-attendance-engine       d279bba   PR #37  Draft
                 ├─ feat/slice3-monthly-summary    08b55ba   PR #39  Draft  (R-01)
                 │    └─ feat/agent-core-live-decisions   PR #40  Draft  (Jev live)
                 │         └─ feat/slice4-attendance-reports  PR #41  Draft  (R-02)  <== TIP
                 └─ docs/daily-closeout-20261015          PR #38  Draft  (memory docs, older snapshot)
```

| Ref | SHA | Tracks origin? | Notes |
|---|---|---|---|
| `feat/slice4-attendance-reports` | `9fbca5f` | in sync | **the tip.** Slice 4 / R-02: individual attendance reports; PR #41 |
| `feat/agent-core-live-decisions` | `fbfb2e4` | in sync | Jev live decisions, the Jev rule, and this memory set; base of #41 |
| `feat/slice3-monthly-summary` | `08b55ba` | in sync | Slice 3: monthly summary (R-01) |
| `docs/daily-closeout-20261015` | see `git log -1` | in sync | memory docs, but an **older snapshot without the Jev work** |
| `feat/slice2-attendance-engine` | `d279bba` | in sync | Slice 2 code |
| `feat/slice1-employee-master-foundation` | `5910819` | in sync | base of #37 |
| `integration/attendance-sso-hip` | `7d810d8` | in sync | base of #36 |
| `main` (local) | `e3cef26` | **behind 3** | **stale — do not use as a reference** |
| `origin/main` | `3244553` | — | the real baseline |

**Start a new session from `feat/slice4-attendance-reports`** — it is the tip and holds the Jev work, the
memory set and the R-02 reports together.

Verified with `git branch -vv`, `git rev-parse`, `git ls-remote`. **No local commit is missing from origin
on the Slice 1/2 chain.**

### Slice 1 commits (`d777fe4`, `3841424`, `5910819`)
### Slice 2 commits (`d12e381`, `c785ffb`, `8e33d92`, `d279bba`)

## 2. Open pull requests (VERIFIED)

| PR | Title | Base | Head | Draft | Checks | Mergeable |
|---|---|---|---|---|---|---|
| [#36](https://github.com/numtip/RAE-Attendance-System-V2/pull/36) | Slice 1 — employee master + attendance data foundation | `integration/attendance-sso-hip` | `5910819` | **yes** | 8/8 pass | CLEAN, unmerged |
| [#37](https://github.com/numtip/RAE-Attendance-System-V2/pull/37) | Slice 2 — versioned attendance engine + Agent Core | `feat/slice1-employee-master-foundation` | `d279bba` | **yes** | 8/8 pass | CLEAN, unmerged |
| [#38](https://github.com/numtip/RAE-Attendance-System-V2/pull/38) | Daily closeout + project memory (docs only) | `feat/slice2-attendance-engine` | this branch | **yes** | 8/8 pass | CLEAN, unmerged |
| [#39](https://github.com/numtip/RAE-Attendance-System-V2/pull/39) | Slice 3 — monthly summary (R-01) | `feat/slice2-attendance-engine` | `08b55ba` | **yes** | 8/8 pass | CLEAN, unmerged |
| [#40](https://github.com/numtip/RAE-Attendance-System-V2/pull/40) | Agent Core (Jev) decision path made to work | `feat/slice3-monthly-summary` | `fbfb2e4` | **yes** | 8/8 pass | CLEAN, unmerged |
| [#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41) | Slice 4 (R-02) — individual attendance reports that surface completeness | `feat/agent-core-live-decisions` | `9fbca5f` | **yes** | see CI | unmerged |

Stacked deliberately: `#41 → #40 → #39 → #37 → #36 → integration/attendance-sso-hip`. **Do not retarget or
merge** until the lower stack (`#30 → #33 → #34/#35`) is decided — see `docs/SESSION_HANDOFF.md` §2 for that
flow.

## 3. Feature status

| Area | State | Evidence |
|---|---|---|
| Employee master, effective-dated | **implemented** | migration `020`, PR #36 |
| Identity mapping, effective-dated | **implemented** | migration `020`, PR #36 |
| FaceScan/HIP CSV ingestion (validation, dedup, provenance) | **implemented** | migration `021`, PR #36 |
| Versioned attendance rules + effective dates | **implemented** | migration `022`, PR #37 |
| Daily attendance calculation with provenance + idempotency | **implemented** | migration `023`, PR #37 |
| **Attendance rule `AR-0001` approved for 2026** | **approved 2026-10-16** | owner decision; `approved_by` is a session label, not a person |
| **Monthly summary derived from daily rows** | **implemented** | migration `024`, PR #39 |
| Holiday calendar / per-employee schedule | **implemented, empty** | tables exist, no approved data |
| Manager/HR dashboards, exports, annual forms | **missing** | not started |
| Individual attendance reports (R-02) | **implemented 2026-10-16 — read-only, no migration, not committed** | `GET /attendance/report/day`, `/month`, `/academic-year`; `docs/unified/10_SLICE4_ATTENDANCE_REPORTS.md` |
| **Agent Core (Jev) decision path** | **WORKING — verified against the live gateway 2026-10-16** | `docs/AGENT_CORE_LIVE_USAGE.md`, PR #40 |
| MJU SSO live | **blocked external** | `ac` semantics unconfirmed |
| Production migrations | **NOT APPROVED** | live ledger is pre-`013` (REPORTED) |

## 4. Workspace preservation (VERIFIED 2026-10-15)

Counts re-measured today rather than assumed:

| Item | Count | Detail |
|---|---|---|
| `git status --porcelain` entries | **18** | 4 modified + 14 untracked |
| Stashes | **2** | `stash@{0}` pre-integration main WIP; `stash@{1}` `wip release1 frontend` |
| Git worktrees | **1** | the workspace itself only |

Modified (pre-existing WIP, **not** part of any of my commits): `.env.example`, `.gitignore`, `AGENTS.md`,
`docs/SESSION_HANDOFF.md`.
Untracked: `.ai/`, `docs/06a_VPS_A_AUDIT_SUMMARY.md`, `docs/07_VPS_B_HOST_AUDIT.md`,
`docs/MJU_SSO_INVESTIGATION_20261015.md`, `docs/RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md`,
`docs/SSO_VPS_DEPLOYMENT_AUDIT.md`, `docs/sampleCallback.aspx(.vb)`, `docs/unified/00`–`05`.

Also preserved: `G:\ProjectAI\_backups\main-uncommitted-20261009`. **Never delete any of these without
explicit approval.**

### 4a. Local-only commits found today (pre-existing, needs an owner decision)

`git log --branches --not --remotes` reports **two commits that exist on no remote**:

```
10bd496 feat facescan raw ingestion phase A staging batch idempotency
99e55b1 feat identity foundation employee_identifier resolution service
```

on the stale local branch `feat/attendance-core-service` (its remote is `gone`; `origin/feat/attendance-core-service`
does not exist). Evidence gathered (VERIFIED):

* Neither commit is reachable from `origin/integration/attendance-sso-hip` or `origin/feat/slice2-attendance-engine`.
* The three files unique to that branch — `backend/src/repositories/mariadb/facescanRawMariaDbRepository.js`,
  `backend/src/services/facescanRawIngestionService.js`, `backend/tests/facescanRawIngestion.test.js` —
  exist **nowhere on origin**, and **nothing in the current tree references them** (`rg` returns no match).
* Migration `015_facescan_hip_ingestion.sql` states in its header: *"HIP Pm2014 FaceScan model (replaces 014
  skeleton)"*, i.e. the raw skeleton was deliberately superseded by the HIP implementation.
* The branch's three docs (`docs/IDENTITY_CONTRACT.md`, `docs/IDENTITY_IMPLEMENTATION.md`,
  `docs/FACESCAN_RAW_INGESTION.md`) **already exist on origin**, so they are not stranded.

**Conclusion:** superseded work stranded on a dead branch (REPORTED/INFERRED from the above), not code
needed to reproduce Slice 1 or 2. **Do not delete the branch without owner approval** — this is the
pre-existing hygiene item `L3`/`O-08` in the Phase-1 backlog.

## 5. Migration inventory (VERIFIED)

`001`–`023`, applied in **lexicographic filename** order; the ledger keys on the full filename with **no
checksum**, so **never rename an applied migration**. Two deliberate prefix collisions: two `013_` and two
`015_` files. `018`/`019` are reserved by draft PR #35, which is why the slices start at `020`.

Slice 1: `020` (assignment + identifier validity), `021` (ingestion provenance).
Slice 2: `022` (rules/holidays/schedules), `023` (daily provenance + `pending` status).

Full dependency table and deploy-order constraints: `docs/unified/08_MIGRATION_DEPENDENCY_GRAPH.md`.

**Production status: NOT APPLIED, NOT APPROVED.** The live ledger is pre-`013` (REPORTED), so the stock
runner cannot be pointed at the live database. No apply order is proposed by any of these documents.

## 6. Known risks

| # | Risk | Where recorded |
|---|---|---|
| R1 | **`Date` vs string** — has broken two consecutive slices; hidden from local tests by the fixture twins | `08_MIGRATION_DEPENDENCY_GRAPH.md` §4 |
| R1b | **Timestamp strings compared across formats** — a naive `'2031-11-03 23:00:00'` and an ISO `'2026-10-16T04:16:45.000Z'` do not order lexicographically, so a staleness check produced a false positive. Fixed by normalising to epoch millis (`toEpochMillis`). Same family as R1. | `09_SLICE3_MONTHLY_SUMMARY.md` §4 |
| R2 | **`AR-0001` `approved_by` is a session label, not a person.** Values are approved; the accountable individual is not yet named. | `ATTENDANCE_RULES.md`, `09_SLICE3…` §1 |
| R3 | Eight open policy questions (P-01…P-08), notably night-shift lateness, which keeps night-shift months `partial` | `docs/ATTENDANCE_RULES.md` §6 |
| R4 | `agent/` still not linted in CI (config exists; no pinned dep or lockfile) | `NEXT_ACTIONS.md` S2-H |
| R5 | ~~Live Agent Core untested~~ **RESOLVED 2026-10-16: Jev verified working** (real decisions with `provider_request_id`). Remaining: Jev is not yet wired into any automated workflow, and its scope is `decision` only | `docs/AGENT_CORE_LIVE_USAGE.md` |
| R6 | Pre-`013` live ledger blocks any production migration | `08_MIGRATION_DEPENDENCY_GRAPH.md` §5 |
| R7 | Legacy VPS-B exposure and `ERROR 1932` recovery remain untouched | `docs/unified/03`, `05` |
| R8 | **The holiday calendar is empty**, so `expected_working_days` counts only the working week — correct but incomplete | `09_SLICE3…` §6 |
| R9 | ~~The frontend monthly view had no completeness verdict~~ **RESOLVED 2026-10-16**: `AttendanceMonthlyView.vue` now reads `/attendance/report/month/...` and renders the verdict before the figures. | `docs/unified/10_SLICE4_ATTENDANCE_REPORTS.md` §4 |

## 7. Authority for "what is current"

`docs/SESSION_HANDOFF.md` remains authoritative for the **pre-Slice** stack (`#30`/`#33`/`#34`/`#35`,
migration `013`–`017` history, the VPS checklists). **This file is authoritative for Slice 1/2 and the
state as of 2026-10-15.** Where they disagree about the current branch/PR tip, believe this file — it was
measured today. The handoff carries uncommitted WIP and was intentionally not edited.
