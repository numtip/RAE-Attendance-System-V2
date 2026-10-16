# 12 — Slice 6 (R-04): attendance reconciliation snapshot

Status: **`SLICE6_READY_FOR_REVIEW`** — implementation complete, all gates green locally.
**No migration. Not merged. Nothing applied to any host.**

Builds on [`11_SLICE5_ATTENDANCE_EXPORTS.md`](11_SLICE5_ATTENDANCE_EXPORTS.md) (R-03, PR
[#42](https://github.com/numtip/RAE-Attendance-System-V2/pull/42)).

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-16 (Asia/Bangkok) |
| Branch | `feat/slice6-reconciliation`, stacked on `feat/slice5-attendance-exports` |
| Worktree | **None.** Per `AGENTS.md`. |
| WIP / stashes | Untouched: the 18 pre-existing entries and **2** stashes. |
| Migration | **None.** R-04 is read-only. |
| Source data | **Synthetic fixtures only.** No host contact, no database, no real personnel data. |
| Labels | **VERIFIED** · **REPORTED** · **UNKNOWN** |

**Delivered:** backlog item **R-04** — a read-only reconciliation snapshot that compares the canonical
stored attendance facts against the verified source records they were derived from, for a day, a calendar
month, and a Thai government **fiscal year**.
**Not** delivered: R-05 (annual HR form).

## 1. The two rules that define this slice

### 1.1 Nothing is compared to itself

The snapshot **reuses** `attendanceReportService` (R-02) for report totals and the daily/monthly semantics of
R-01/R-02 — it does not re-implement them. So a "report totals" check compares the R-02 report against the
stored month row, and the daily checks compare the canonical row against the events actually attributable to
the employee. There is one attendance truth in the system, and reconciliation audits it rather than creating
a second one.

**18 checks** are implemented, each returning `{ code, status, observed, expected, detail, severity }`:

| Scope | Checks |
|---|---|
| day | `employee_identity`, `approved_rule`, `scan_presence`, `scan_count`, `event_span`, `duplicate_scans`, `unattributed_events`, `foreign_events`, `leave_agreement`, `workday_classification`, `computation_status` |
| period | `employee_count`, `daily_row_coverage`, `month_totals`, `expected_working_days`, `report_totals_agreement`, `unjudged_days`, `fiscal_month_coverage` |

### 1.2 "Nothing to compare" is not agreement

The status precedence is `blocked > mismatched > incomplete > matched`, and:

* **`blocked`** — reconciliation cannot proceed at all (identity ambiguous/conflicting, or a required source
  absent). Every identity branch resolves to `blocked`, never to `matched`: an employee with two effective
  assignments on one date, or a conflicting identifier, is **flagged, never merged, and never reassigned**.
* **`incomplete`** — no disagreement found, but the period cannot be judged in full.
* **`mismatched`** — a factual disagreement between comparable values.
* **`matched`** — every check passed.

A period with no rows is **`incomplete`, never `matched`** (the same trap E26 guards on the monthly side;
pinned by a test).

`mismatched` is only ever raised between **commensurable** values. The fiscal-year aggregates
(`month_totals`, `expected_working_days`, `report_totals_agreement`) compare **only months that were actually
derived**, and report `incomplete` when months are missing — a sum over 1 month compared against a sum over
12 would be a false mismatch, which is the same class of error as R-01's "phantom month". This was a real
defect found by this slice's own test (see §4).

### 1.3 The fiscal year is NOT the academic year

| Period | Window | Where |
|---|---|---|
| Thai **academic** year (R-02) | 1 June – 31 May | `attendanceReport.js`, `ACADEMIC_YEAR_START_MONTH = 6` |
| Thai government **fiscal** year (R-04) | 1 October – 30 September | `reconciliationPeriod.js`, `FISCAL_YEAR_START_MONTH = 10` |

`fiscalYear 2569` (Buddhist Era) is **2025-10-01 .. 2026-09-30**. The two modules do not import each other,
and a test asserts the windows **differ** for the same year. Every snapshot names the BE year, the Gregorian
window and a Thai label (`ปีงบประมาณ 2569`), so the two cannot be confused by a reader.

**REPORTING CONVENTION NEEDING OWNER CONFIRMATION:** the repository has never had a fiscal period before, so
"fiscal year = government Oct–Sep" needs the same explicit owner sign-off that `P-05`/`P-06` get. Until then
it is a stated convention, not a policy.

## 2. Interfaces

### 2.1 New backend files

| File | Lines | Purpose |
|---|---|---|
| `src/domain/reconciliationPeriod.js` | 136 | Pure fiscal-year period (Oct–Sep), boundaries, BE label. |
| `src/domain/reconciliation.js` | 708 | Pure: check builders, the 18 checks, `verdictOf`, `REAL_SOURCE_NOTE`. |
| `src/services/reconciliationService.js` | 687 | Reads the stores, runs the checks, builds the envelope + `snapshotHash`. |
| `src/controllers/reconciliationController.js` | 44 | JSON responses (`success()`), unlike the R-03 exports. |
| `tests/helpers/reconciliationSources.js` | 461 | 10 synthetic source scenarios. Test-only. |
| `tests/reconciliation.test.js` + `reconciliationPeriod.test.js` | 514 + 87 | 27 tests. |

`backend/src/api/v1/index.js` gains **15 lines** (2 requires, wiring, 3 routes) and nothing else.

### 2.2 API (read-only — there is no POST/derive variant)

| Method | Path |
|---|---|
| GET | `/api/v1/attendance/reconciliation/day/:employeeUid/:date` |
| GET | `/api/v1/attendance/reconciliation/month/:employeeUid/:year/:month` |
| GET | `/api/v1/attendance/reconciliation/fiscal-year/:employeeUid/:fiscalYear` |

All three are in `docs/API_CONTRACT.md` and exercised by `contract:smoke` (**36** paths, was 33).

### 2.3 The snapshot envelope

`snapshot.status` · `statusReasons` · `checks` · `counts` · `unresolvedExceptions` · `completeness` ·
`period` · `population` · `asOf` · `cutoff` · `sourceTables` · `ruleVersions` · `snapshotHash` ·
`pristine: true` · `realSourceVerified` + `realSourceNote`.

* `pristine: true` states the reconciliation wrote nothing.
* `snapshotHash` is a SHA-256 over a canonical body that **excludes** `asOf`/`cutoff` (both derived from the
  clock) and the hash itself, so identical data hashes identically across runs and the determinism test is
  meaningful. Which fields are excluded, and why, is documented at the hash site.
* Authorization uses the **same** `assertCanReadEmployee` guard as R-02, **scope before existence**, before
  any data read — so the two cannot drift.

## 3. `realSourceVerified: false` — the input that is missing

**`G:\ProjectAI\attendance-report-generator` DOES NOT EXIST** (VERIFIED 2026-10-16 by directory check). The
reference named for FY2569 historical reconciliation is unavailable, so **no FY2569 real-source evidence was
or could be consulted.**

Every snapshot therefore carries, **inside the payload**:

```json
"realSourceVerified": false,
"realSourceNote": "Reconciled against stored V2 records only. No external FY2569 source (e.g. the
  attendance-report-generator reference) was available or consulted, so this snapshot does NOT verify the
  original HIP/MJU source data."
```

This is deliberately machine-visible rather than a sentence in a document: a consumer cannot read a
`matched` snapshot and believe the original HIP/MJU data was verified. A test asserts the flag is `false` and
the note is present, so the claim cannot silently change.

**Consequence:** R-04 currently validates V2's *internal* consistency (stored rows vs the rows they were
derived from). It does **not** validate V2 against the original source system. That half of the requirement
is **BLOCKED on `R-04-B`**, not done.

## 4. Defects found during development (recorded, not hidden)

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | **important (false verdict)** | The fiscal-year `expected_working_days` check summed over **all started months**, mixing `NULL` (never derived) with real figures. A fiscal year where only one month was derived produced a **false `mismatched`** — comparing a 1-month sum against a 12-month sum. Its sibling checks already filtered to commensurable months; this one did not. | Filter to months that were derived, and report `incomplete` when months are missing. **Fixed in the service, not by relaxing the test** — the test's `incomplete` expectation was the honest one. |

## 5. Verification

### 5.1 Gates (all run locally)

| Gate | Command | Result |
|---|---|---|
| Lint | `cd backend && npm run lint` | **PASS** |
| Reconciliation suites | `node --test tests/reconciliation*.test.js` | **PASS — 27/27** |
| Full backend suite | `cd backend && npm test` | **PASS — 461 tests, 451 pass, 0 fail, 10 skipped** (was 434) |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS — 36 paths** (was 33) |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS — 373 files** |
| Frontend build | `cd frontend && npm run build` | **PASS** |
| MariaDB / CI | GitHub Actions on the Draft PR | see the PR checks |

### 5.2 Independent verification (orchestrator, not the implementation's own tests)

A separate probe drove the service directly against fixture repositories:

| Claim | Result |
|---|---|
| **Source immutability** — no store changed by a reconciliation | **PASS** — deep key-sorted snapshot of every enumerable store, before and after all 5 kinds (day, 3 months, fiscal year): **0 stores changed**, and `pristine: true` in every payload. The suite's own version is stronger still: it **poisons all 11 write methods across 5 repositories** so an accidental write throws, and a mutation confirmed that gate is real (§5.2 last row) |
| Deterministic | **PASS** — identical `snapshotHash` across two runs; the suite's version spans clocks a year apart |
| Empty period is not "matched" | **PASS** — a month with no rows → `incomplete` |
| Fiscal ≠ academic | **PASS** — fiscal `2025-10-01..2026-09-30` vs academic `2026-06-01..2027-05-31` |
| Cross-scope refused | **PASS** — 403/FORBIDDEN for day, month and fiscal year |
| No PII / secrets in the payload | **PASS** — screened for `passwordHash`, `national_id`, any 13-digit national id, `Bearer`, JWT-shaped strings, `hmac`, facescan ids |
| **`mismatched` is reachable and correct** | **PASS** — the raw fixture seed month (a stored row with no daily rows) yields `mismatched`, while the `cleanMonth` scenario yields `matched`: the same code distinguishes a real disagreement from a mere gap |
| **The read-only gate is not vacuous** | **PASS (mutation)** — injecting `await daily.upsertDay(...)` into `reconcileDay` made the read-only test **fail** with `write attempted: upsertDay`. Reverted; 27/27 and the full suite green again. A test that passes whether or not the code writes would prove nothing |

Two guarantees in the suite are stronger than the §5.3 matrix implies, and are worth naming:

* **Determinism is tested across clock difference, not just a repeat.** The same data is reconciled with the
  clock set to `2026-10-16T00:00:00Z` and then `2027-05-01T13:45:00Z` — over a year apart. The `snapshotHash`
  is asserted **equal** while `asOf` and `cutoff` are asserted **different**. That is what proves the hash
  input really excludes the clock rather than merely being stable within one second.
* **The same-name scenario asserts non-disclosure.** Beyond keeping the two employees distinct, it asserts the
  shared Thai name and the other employee's `employee_uid` appear **nowhere** in the payload. Identity data
  does not leak through a reconciliation response.

### 5.3 Scenario matrix (from the suites)

| Scenario | Kind | Status | Signal |
|---|---|---|---|
| clean month (day) | day | **`matched`** | every check passes |
| clean month (month) | month | **`matched`** | every check passes |
| same-name employees | day | **`matched`** ×2 | two distinct populations, both clean — proves no name-based join |
| duplicate scans | day | `incomplete` | device artefact reported, `scan_count` stays `matched` |
| **conflicting employee codes** | day | **`blocked`** | identity conflict flagged, never merged |
| missing scans | month | `incomplete` | |
| partial month | month | `incomplete` | |
| pending policy (2027) | day | `incomplete` | `employee_identity` `matched`, rule unapproved |
| never derived | month | `incomplete` | explicitly asserted **not** `matched` |
| unattributed + foreign scans | day | `incomplete` | never reassigned |
| lease February 2028 / boundaries | period | overridden | leap + fiscal boundary pinned |
| fiscal year, partially derived | fiscal | `incomplete` | missing months are a gap, not a mismatch |

### 5.4 Residual test-coverage gap (recorded)

The suites pin `matched`, `incomplete` and `blocked` at snapshot level, and `mismatched` is unit-tested at the
`verdictOf` level. **No scenario in the suite asserts a snapshot-level `mismatched` from real data** — it is
reached only by the orchestrator probe in §5.2. Cheap to close (the raw fixture seed month is exactly such a
case), and better closed than assumed.

## 6. Unresolved / out of scope

1. **`R-04-B`: the reference project is missing**, so no FY2569 real-source verification was possible. This is
   the largest open item; everything in §5 is fixture-verified only.
2. **The fiscal convention needs owner confirmation** (§1.3): Oct–Sep is a stated reporting convention, not an
   approved policy value.
3. **`mismatched` is not pinned by a scenario test** (§5.4).
4. **Reconciliation is not exposed in the frontend.** Not required by this slice, and `AttendanceDailyView`
   still renders raw records rather than a report.
5. **No scheduled/automated reconciliation run.** Snapshot generation is on-demand; there is no cron, alert or
   stored history of past snapshots.
6. **`approvedBy` remains a session label** (R2), so a `matched` snapshot does not name an accountable
   approver.
7. **`realSourceVerified` has no positive path yet.** When a real source becomes available, the flag must
   become conditional and the test in §3 updated — today it is unconditionally `false`.

## 7. Review checklist

- [ ] Read-only by construction accepted: no write path, `pristine: true`, and an immutability test that
      snapshots every store.
- [ ] Status precedence accepted, including that a period with nothing to compare is `incomplete`, never
      `matched`.
- [ ] Identity ambiguity → `blocked`, never merged or reassigned, and never joined by name.
- [ ] The fiscal year (Oct–Sep, BE `:fiscalYear`) accepted as a **separate** convention from the R-02
      academic year (Jun–May).
- [ ] `mismatched` only between commensurable values (the §4 defect) accepted as the rule.
- [ ] `realSourceVerified: false` + an explicit note in the payload accepted as the honest treatment of a
      missing external source, with `R-04-B` tracked.
- [ ] `snapshotHash` excluding clock-derived fields accepted as what makes determinism meaningful.

## 8. Next actions

| ID | Task | Note |
|---|---|---|
| **R-04-B** | Resolve `G:\ProjectAI\attendance-report-generator`, or formally record that FY2569 real-source reconciliation is out of scope | **Blocks the verification half of R-04** |
| R-04-T | Pin a snapshot-level `mismatched` with a scenario test | §5.4 |
| R-05 | Annual HR form (แบบรายงานประจำปี) | Reuses the R-03 renderer |
| — | Owner confirmation of the fiscal-year window | §1.3 |
