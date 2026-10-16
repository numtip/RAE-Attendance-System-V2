# STATUS — RAE Attendance System V2

**As of:** 2026-10-16 16:20 (Asia/Bangkok) · **Day status:** `DAY_20261016_CLOSED`
**Authoritative for current state.** Supersedes `docs/SESSION_HANDOFF.md` (pre-Slice, carries another
session's WIP) and `docs/memory/PROJECT_STATE.md` for anything newer.

**Labels:** **VERIFIED** = a command was run today · **REPORTED** · **UNKNOWN**

---

## 1. Where the code is

| | |
|---|---|
| Working branch | `docs/id6b-review-and-r1r3-package` @ **`3f2f343`** |
| Remote tracking | `origin/docs/id6b-review-and-r1r3-package` — **in sync** (VERIFIED) |
| Worktrees | **1** (the workspace) |
| Stashes | **2** (`stash@{0}` pre-integration main WIP, `stash@{1}` wip release1 frontend) |
| Pre-existing WIP | **4 modified** files, untouched all session: `.env.example`, `.gitignore`, `AGENTS.md`, `docs/SESSION_HANDOFF.md` |
| Untracked (pre-existing) | **19** entries — `.ai/`, `docs/unified/00`–`05`, `docs/06a_*`, `docs/07_*`, `docs/MJU_SSO_INVESTIGATION_*`, `docs/RAE_ATTENDANCE_UNIFIED_*`, `docs/SSO_VPS_*`, `docs/sampleCallback.aspx(.vb)` |
| `origin/main` | `3244553` (2026-10-02). Local `main` is **stale** (`e3cef26`) — do not use as a reference |
| Highest migration | **`024`** → `025` is the next free number |

## 2. Open Draft PRs — the stack

```
origin/main 3244553
 ├─ #44  fix/pii-national-id-fixtures        -> main        PII REDACTION (independent of the stack)
 └─ #40 -> #41 -> #42 -> #43 -> #45 -> #46 -> #47 -> #48
```

| PR | Head | Base | Tip SHA | CI |
|---|---|---|---|---|
| [#48](https://github.com/numtip/RAE-Attendance-System-V2/pull/48) | `docs/id6b-review-and-r1r3-package` | #47 | `3f2f343` | **8/8 pass** |
| [#47](https://github.com/numtip/RAE-Attendance-System-V2/pull/47) | `fix/id7b-enrichment-outcome-fail-closed` | #46 | `6400c6a` | **8/8 pass** |
| [#46](https://github.com/numtip/RAE-Attendance-System-V2/pull/46) | `feat/slice7-annual-hr-report` | #47's parent chain | `e522bd5` | **8/8 pass** |
| [#45](https://github.com/numtip/RAE-Attendance-System-V2/pull/45) | `feat/identity-hardening` | #43 | `081b9db` | 8/8 pass |
| [#44](https://github.com/numtip/RAE-Attendance-System-V2/pull/44) | `fix/pii-national-id-fixtures` | **main** | `850e3fc` | **8/8 pass** |
| [#43](https://github.com/numtip/RAE-Attendance-System-V2/pull/43) | `feat/slice6-reconciliation` | #42 | `04ff9d0` | 8/8 pass |
| [#42](https://github.com/numtip/RAE-Attendance-System-V2/pull/42) | `feat/slice5-attendance-exports` | #41 | `16eb679` | 8/8 pass |
| [#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41) | `feat/slice4-attendance-reports` | #40 | `6c0fe2a` | 8/8 pass |
| [#40](https://github.com/numtip/RAE-Attendance-System-V2/pull/40) | `feat/agent-core-live-decisions` | #39 | — | 8/8 pass |

**All are Draft. Nothing is merged.** `#44` targets `main` because the exposure it fixes is on `main`.
The lower stack (`#30 → #33 → #34/#35`) is unchanged and still undecided.

**Merge order when the time comes:** lower stack first, then `#40 → #41 → #42 → #43 → #45 → #46 → #47 → #48`.
Any merge needs explicit owner approval.

## 3. Delivered today (2026-10-16)

| Item | Where | Status |
|---|---|---|
| **R-02** individual attendance reports | `docs/unified/10_*` | Delivered, PR #41 |
| **R-03** export (PDF + XLSX, DRAFT watermark) | `docs/unified/11_*` | Delivered, PR #42 |
| **R-04** reconciliation snapshot | `docs/unified/12_*` | Delivered, PR #43 |
| **R-04-C** transcribed FY2569 aggregate evidence | `docs/unified/12_*` §5.5 | Delivered |
| **ID-6 / ID-7** subject guard + frozen source allowlist | `docs/IDENTITY_MAPPING_CONTRACT.md` | Delivered, PR #45 |
| **ID-7b** fail-closed enrichment guard (**P0 security**) | F3/F4 in the contract | Delivered, PR #47 |
| **R-05** annual HR report | `docs/unified/14_*` | Delivered, PR #46 |
| **ID-6b / S-02** identity-evidence design | `docs/IDENTITY_EVIDENCE_MODEL.md`, `docs/adr/ADR-011-*` | Design only, PR #48 |
| **R1/R3** privacy incident review package | `docs/incident/*` (5 files) | Review only, PR #48 |
| Reference + identity-source audits | `docs/unified/13_*`, `docs/IDENTITY_INTEGRATION_AUDIT.md` | Delivered |

Session-wide narrative: [`SESSION_SUMMARY_20261016_PARALLEL_TRACKS.md`](SESSION_SUMMARY_20261016_PARALLEL_TRACKS.md).

## 4. QA evidence

| Gate | Result |
|---|---|
| Backend lint | **clean** |
| Backend suite (fixtures) | **538 tests, 526 pass, 0 fail, 12 skipped** |
| `contract-smoke` | **40 paths** |
| Secret scan | **409 files** |
| Frontend build | pass |
| PII screen (all new docs, 4 encodings each) | **clean** |
| CI on #44/#46/#47/#48 | **8/8 pass** each |

### 4.1 Local MariaDB 11.4.2 — recorded SEPARATELY from CI and fixture runs

The ID-7b P0 fix required real-twin evidence, so a **throwaway MariaDB 11.4.2** (matching CI's version) was
stood up locally in `%TEMP%`, all **24 migrations + dev seed** applied, and the tests run against it:

| Check | Result |
|---|---|
| Migrations applied to a real server | **24** files + seed, exit 0 |
| API against real MariaDB (`/api/v1/health/db`) | `connected`, `attendance_v2` |
| Real login + authenticated read against MariaDB | 200, correct employee/role |
| **`identityLinkEnrichment.mariadb.test.js` (ID-7b)** | **2/2 PASS** on the live DB |

**Why this is reported separately:** it is *local* evidence from a *throwaway* server, not CI and not a
fixture run. It is stronger than a fixture run and weaker than the CI `backend-mariadb` job (fresh container,
Linux). Both agree — CI also passed `backend-mariadb` on #47.

**Local-run limitations discovered (standing rules 13–14):**

* The **aggregate** run (`node --test tests/*.test.js`) reports four files as `'test failed'` on Windows.
  Those are **teardown-only** libuv crashes (`!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`) under
  `--test-force-exit`; **every test inside them passed** (`actual_test_failures=0` in each of `health`,
  `sso`, `ssoPass9`, `mariadb.integration`). Run **one file per process** locally.
* `TZ=UTC` is required, else the documented `facescanNormalization` UTC+7 case fails (`15:00` vs `08:00`).
* A **fresh** database is required: `facescanIngestion.mariadb.test.js` returns `'duplicate'` instead of
  `'inserted'` on a used DB (documented known issue).

## 5. Blockers and open items

### 5.1 🔴 Privacy incident — OPEN, and the value is still public

**A real Thai national ID (masked `****5351`) is committed in this PUBLIC repository.** The file-level
redaction (R2/R4/R5) is done, but **history remediation is NOT**, and the value remains retrievable from
**`origin/main` (`3244553`, introduced 2026-10-02, PR #32)**.

* `83aaa53` is **not** an ancestor of `origin/main` — a rewrite keyed on it would leave the value public.
* **No redaction exists on main's line.** `#44` is the file-level fix; it does not remove history.
* **Notification: NOT sent.** **History rewrite: NOT done.** Both are owner decisions.
* Full record: [`docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`](SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md);
  decision package: `docs/incident/`.

### 5.2 Other blockers

| ID | Blocker | Note |
|---|---|---|
| **ID-7b-rem** | Durable fix for the enrichment outcome needs column(s) → **migration `025`**, a proposal only | The security fix shipped without it |
| **ID-3 / G7** | Real identity integration **not activated** | Needs owner approval + **DPIA + privacy-officer sign-off** |
| **ID-5** | The MJU Person API returns **no `personnelID`** (0/308) | Cannot populate the MJU identity kind |
| **ID-4** | `MJU_PERSON_ENRICHMENT_KB.md` **does not exist** | Cited as the "personal-data local-only policy" |
| **R-05b** | Cross-employee code-holder change not **positively** detectable | Safety property holds; detection needs a new repository method |
| **D-02** | Legacy `attendance_db` **not found** on the local USBServer MySQL 5.6 (and 5.6 cannot host V2: 6 migrations use `JSON`) | Where is the legacy DB? |
| **G-mig** | Migration `025` approval | Proposal under `database/proposals/`, deliberately NOT in `database/migrations/` |
| **R2** | `approved_by` on `AR-0001` is a **session label**, not a person | Blocks using the values against a person |
| **R8 / S2-D** | Holiday calendar **empty** | `expected_working_days` counts the working week only |
| **P-03** | Night-shift lateness underfined | Night-shift months stay `partial` |

## 6. Hard constraints in force (unchanged)

No merge · no PR retarget · no force push · no history rewrite · no production migration/deploy · no
real-identity import · no notification · no secret creation/rotation · all existing stashes, WIP and
unrelated branches preserved.
