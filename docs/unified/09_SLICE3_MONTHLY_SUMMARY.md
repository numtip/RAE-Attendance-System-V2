# 09 — Slice 3: monthly summary derived from daily attendance

Status: **`SLICE3_READY_FOR_REVIEW`** — implementation complete, tests green locally, CI green on the PR.
**Not merged, no migration applied to any host.**

Extends [`07_SLICE2_ATTENDANCE_ENGINE.md`](07_SLICE2_ATTENDANCE_ENGINE.md) (PR
[#37](https://github.com/numtip/RAE-Attendance-System-V2/pull/37)), stacked on
[#36](https://github.com/numtip/RAE-Attendance-System-V2/pull/36).

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-16 (Asia/Bangkok) |
| Branch | `feat/slice3-monthly-summary`, stacked on `feat/slice2-attendance-engine` @ `d279bba` |
| Worktree | **None.** Per `AGENTS.md` ("do not create Git worktrees"). |
| WIP / stashes | Preserved: **18** entries, **2** stashes (re-counted at the start of this session). |
| Hosts | **Not contacted.** No SSH, no production DB, no deploy, no migration applied. |
| Redaction | No PII, secret or national ID in this document or in any Slice 3 file. |
| Labels | **VERIFIED** · **REPORTED** · **UNKNOWN** |

**Delivered:** backlog item **R-01** (a `monthly_summary` writer derived from `daily_attendance` with
provenance and a completeness verdict), plus the owner's **rule approval** that was gating it.
**Not** delivered: R-02 (the report surface) and R-03 (exports).

## 1. The owner decision that unblocked this

`AR-0001` was `pending_approval`, so the engine reported `pending_policy` and produced no numbers. On
2026-10-16 the owner **approved the candidate values**: work `08:30–16:30`, late after `08:30`, early
before `16:30`, working week Mon–Fri.

Recorded honestly rather than glossed:

* `AR-0001` is now `approved` with `approvedFrom 2026-01-01` / `effectiveTo 2026-12-31` and
  `approvedBy: 'owner:session-2026-10-16'`.
* **`approvedBy` is a session label, NOT a person.** The database `CHECK` requires an approver to be
  present so an untraceable approval cannot be written, but naming the accountable individual is still
  required before any production use. This is flagged in the fixture, in the rule's `notes`, and here.
* A second fixture rule **`AR-0002`** (`pending_approval`, effective 2027-01-01) was added as the
  unapproved successor. It keeps the honesty gate **demonstrable end to end**: a 2026 date computes, and a
  2027 date reports `pending_policy` because the only rule covering it is unapproved.

Four Slice 2 test assertions changed as a direct consequence (they asserted the fixture shipped a
pending-only rule). They were updated to assert the *approved* path plus the 2027 gate, which is a
stronger test than before. **No production code was changed to make them pass.**

## 2. What Slice 3 adds

### 2.1 The completeness contract (the point of the slice)

A month total is only meaningful if every day inside it could be judged. So every derived month carries a
`computation_status`:

| Status | Meaning |
|---|---|
| `no_data` | no stored daily rows at all for this employee-month |
| `pending_policy` | at least one day is `pending_policy`: an approved rule is missing, so no amount of recalculation fixes the month |
| `partial` | no `pending_policy`, but at least one day is `insufficient_data` or `failed` |
| `calculated` | every stored day was judged |

**A month is never reported as `calculated` while any day inside it is unjudged**, and `pending_days`
counts the days behind a `partial`/`pending_policy` verdict so a reader can see the size of the hole.

The subtle case, which has its own test: a day with day-level `computation_status = 'no_data'` is a
**complete judgement** (the rule said it was a working day and no scan arrived, so the person was absent).
It therefore does **not** make the month partial. Conflating "absent" with "unknown" would have made every
normal month look incomplete.

### 2.2 `expected_working_days` is separate from `total_work_days`

* `total_work_days` counts the days the rule actually classified as workdays **in the stored rows**.
* `expected_working_days` is what the **approved calendar** says should have been worked (working week
  minus approved holidays, and `ignoreHolidays=false` means holidays are worked).

They differ when rows are missing, and that difference **is** the reconciliation signal. The derived
`dayCounts` also reports `missingWorkingDays` and the exact dates.

`expected_working_days` is **NULL, never 0**, when it cannot be derived — and the reason is recorded in
`derivation_notes` (`no_approved_rule` for a specific date, `working_week_not_specified`, or
`calendar not supplied`). A `0` would read as "nobody was expected to work", which is a much stronger and
false claim.

### 2.3 No phantom months

A month with no daily rows **and no existing row is not written**. An empty row would read as a real month
of zeros. It is reported in the run summary instead (`written: false`). An existing row *is* refreshed, so
a month whose days were deleted stops claiming stale figures and becomes `no_data`.

### 2.4 Staleness by value, not by timestamp

`explain` reports `stale` plus `staleReasons`. It compares the **derived result fields** (counts, minutes,
hours, completeness, rule versions), not `calculated_at`.

Why: `calculated_at` necessarily differs on every run, so a timestamp comparison is *always* "stale" and
means nothing; and conversely a derivation and a daily recalculation can land in the **same millisecond**,
so a strict `>` comparison misses a real change. The first implementation used timestamps and the
Slice 3 test caught it — see §4.

### 2.5 Idempotency and derivation, not recomputation

A month is **derived from the stored daily rows**. It never re-reads scans and never recomputes a day, so a
month total can always be traced back to the days that produced it. `upsertMonth` is keyed on
`uk_monthly_summary_employee_period (employee_uid, year, month)` — one row per employee-month, updated in
place.

## 3. Interfaces

### 3.1 Migration `024`

Adds to `monthly_summary`: `computation_status`, `rule_versions_json`, `expected_working_days` (NULLable),
`pending_days`, `holiday_days`, `total_early_minutes`, `day_counts_json`, `derivation_notes`,
`calculated_at`, `source_kind`, plus `UNIQUE (employee_uid, year, month)` and a status index.
Rollback: `database/rollbacks/024_monthly_summary_provenance.down.sql`.

`rule_versions_json` is a **JSON array** because a month can legitimately span a rule change. `total_early_minutes`
closes the same donor gap Slice 2 fixed on the daily side (the donor computed early minutes but never
persisted them).

### 3.2 Domain — `backend/src/domain/monthlyAttendanceCalculation.js` (pure)

`calculateMonthlySummary({ employeeUid, year, month, dailyRows, calendar, calculatedAt })`, plus
`enumerateMonthDays`, `daysInMonth` (leap-year correct: Feb 2028 = 29), `isoDayNumber`, `monthKeyOf`,
`dayKeyOf`. No I/O, no clock.

Defensive by design: rows for another employee or another month are **excluded**, not absorbed, and a
non-numeric minutes value contributes zero rather than `NaN`.

### 3.3 Repository twins

`upsertMonth` · `findForEmployeeMonth` · `listForEmployeeYear` (+ `all()` on the fixture). Both twins
return the **same JSON shape**: `ruleVersions` is always an array and `dayCounts` always an object, with
the MariaDB twin serializing/parsing the JSON columns internally. `expectedWorkingDays` stays `null` when
null.

### 3.4 API

| Method | Path |
|---|---|
| GET | `/attendance/monthly-summary/:employeeUid/:year/:month` |
| GET | `/attendance/monthly-summary/:employeeUid/:year` |
| GET | `/attendance/monthly-summary-explain/:employeeUid/:year/:month` |
| POST | `/attendance/monthly-summary/recalculate/:employeeUid/:year/:month` |
| POST | `/attendance/monthly-summary/recalculate` |

All five are in `docs/API_CONTRACT.md`, so `contract:smoke` exercises them (**27** paths, was 22).

**Authorization.** Deriving is a **write**, so it requires manager/admin — the same rule as the Slice 2
daily recalculation. The organization-wide form requires a resolved **broad** data scope: role alone is not
enough. Both are asserted, including the negative cases.

### 3.5 The legacy monthly route

`GET /attendance/monthly/:employeeUid/:year/:month` is unchanged in contract, and its fixture
implementation now reads the **same store** as the derived endpoints, so fixture mode cannot show two
different versions of the same month.

## 4. Defects found during development (recorded, not hidden)

Three real defects were caught by this slice's own tests before it was pushed. They are listed because two
of them are the kind that ship silently.

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | **blocker (security)** | The Slice 3 service called `assertCanReadEmployee(...)` **without `await`** in four places. An unawaited authorization check does not gate the response: a forbidden read proceeded and returned data, and the rejection surfaced as an unhandled promise rejection. | Added `await` to all four. Verified every call site now awaits (the Slice 2 service was already correct). |
| 2 | important (authorization) | `recalculateMonth` never called `assertCanRecalculate`, so a **plain employee could trigger writes** to `monthly_summary` — inconsistent with the Slice 2 daily recalculation, which is manager/admin only. | Added `assertCanRecalculate(auth)` at the top of `recalculateMonth`. |
| 3 | important | Staleness detection compared `calculated_at` timestamps. A derivation and a daily recalculation can share a millisecond, so a genuine change could be reported as not stale. | Compare the derived **result fields** and surface which changed (`field_changed:<name>`). |

Defect 1 is the notable one: it is invisible in a happy-path test and would have been an authorization
bypass in production. It was caught only because the tests asserted the **negative** case (a plain user
reading someone else's month must get 403).

Additionally, **four of my own test expectations were wrong** and were corrected by reading the output
rather than adjusting the assertions to match the first failure: Mar 6 is scanless so there are two absences
(not one), the early-minutes total is 60 (not 30), `missingWorkingDays` is 17 (not 16, because Mar 1 is a
Sunday), and a recalculation of an existing day **updates** a row rather than adding one — which is itself
a good argument for the value-based staleness check.

## 5. QA evidence

| Check | Command | Result |
|---|---|---|
| Backend lint | `cd backend && npm run lint` | **PASS** |
| Backend suite | `cd backend && JWT_SECRET=… npm test` | **PASS** — `377 tests, 368 pass, 0 fail, 9 skipped` |
| Monthly domain | `node --test tests/monthlyAttendanceCalculation.test.js` | **PASS** 23/23 |
| Slice 3 integration | `node --test tests/slice3MonthlySummary.test.js` | **PASS** 12/12 |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS** — 27 paths (was 22) |
| Agent suite | `cd agent && node --test tests/*.test.js` | **PASS** 46/46 |
| Frontend build | `cd frontend && npm run build` | **PASS** |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS** |
| Real database | CI `backend-mariadb` | applies `001`–`024`; `tests/slice3.mariadb.test.js` verifies the DDL, the JSON round-trip, NULL staying NULL, real idempotency against the unique key, and the derived month |

**Not verified here:** Docker and MariaDB are unavailable locally, so migration `024` was **not applied to
any database** in this session. As with Slices 1 and 2, `backend-mariadb` is the DDL verification and the
only `Date`/string parity check. Never applied to a populated database; no apply order is proposed.

## 6. Unresolved / out of scope

1. **`approvedBy` is a session label.** Naming the accountable approver is required before production use of
   the approved values (see §1).
2. **No report surface yet.** `R-02` (day/month/FY per employee) and `R-03` (XLSX/PDF/annual form) remain.
   The month totals now exist and are honest, so a report can be built without inventing anything.
3. **The holiday calendar is still empty**, so `expected_working_days` counts only the working week. That is
   correct but incomplete until an approved calendar is imported (`S2-D`).
4. **No `attendance_holiday` data** and no schedule data — both tables exist and are unused.
5. **Night-shift lateness is still withheld** (`P-03`), so a night-shift month will show `partial`.
6. **The donor Python Attendance Core proxy routes still exist** (`S2-F`), unchanged.
7. **`agent/` still is not linted in CI** (`S2-H`), unchanged.

## 7. Next actions

The audit surface is now: `next milestone = individual attendance reports (R-02)`, which is **no longer
blocked on the policy approval** — that was granted in §1.

| ID | Task | Depends on |
|---|---|---|
| R-02 | Report endpoints for one employee: day / month / academic year, scope-enforced, each naming its rule version, date cutoff and population | this slice |
| R-03 | Export layer (XLSX, PDF, annual form) with server-enforced filters and export authorization | R-02 |
| R-04 | Reconciliation test: recompute a closed month and match a frozen synthetic snapshot | R-02 |
| S2-D | Holiday calendar import (approved source only) so `expected_working_days` becomes realistic | P-05, P-06 |
| S2-B | Night-shift lateness rule so night-shift months stop being `partial` | P-03 |
| S2-H | Pin `agent/` eslint + lockfile and enforce lint in the `agent-core` CI job | — |
| DOC-1 | Refresh `docs/SESSION_HANDOFF.md`; add the 2026-10-16 entry to `docs/memory/*` | owner approval |

## 8. Review checklist

- [ ] Migration numbering `024` accepted (or renamed **before** any apply).
- [ ] The completeness contract accepted: a month with any unjudged day is `partial`/`pending_policy`, never `calculated`.
- [ ] `expected_working_days` NULL-means-not-derivable accepted (not `0`).
- [ ] The session-label approver accepted for the fixture, with the production follow-up noted.
- [ ] Manager/admin required for monthly derivation, and broad scope for the organization-wide form.
- [ ] `backend-mariadb` CI green.
- [ ] Approval to push `feat/slice3-monthly-summary` and open a **Draft** PR stacked on #37.
