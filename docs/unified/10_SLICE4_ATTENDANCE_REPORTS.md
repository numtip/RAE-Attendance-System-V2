# 10 — Slice 4 (R-02): individual attendance reports

Status: **`SLICE4_READY_FOR_REVIEW`** — implementation complete, lint and tests green locally.
**No migration. No merge. Nothing applied to any host.**

Builds on [`09_SLICE3_MONTHLY_SUMMARY.md`](09_SLICE3_MONTHLY_SUMMARY.md) (PR
[#39](https://github.com/numtip/RAE-Attendance-System-V2/pull/39)).

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-16 (Asia/Bangkok) |
| Branch | `feat/slice4-attendance-reports`, off `feat/agent-core-live-decisions` (PR [#40](https://github.com/numtip/RAE-attendance-System-V2/pull/40)). Commit `9fbca5f`, pushed, **Draft PR [#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41)** with base `feat/agent-core-live-decisions`. Not merged. |
| Worktree | **None.** Per `AGENTS.md`. |
| WIP / stashes | Untouched: the 18 pre-existing entries and **2** stashes. |
| Hosts | **Not contacted.** No SSH, no production DB, no deploy. |
| Migration | **None.** R-02 is read-only, so there is nothing to apply and nothing to rename. |
| Redaction | No PII, secret or national ID in this document or in any Slice 4 file. |
| Labels | **VERIFIED** · **REPORTED** · **UNKNOWN** |

**Delivered:** backlog item **R-02** — report endpoints for one employee, day / month / academic year,
scope-enforced, each naming its rule version, date cutoff and population, and surfacing
`computation_status` instead of hiding a partial month.
**Not** delivered: R-03 (exports) and R-04 (reconciliation snapshot).

## 1. The contract this slice exists to enforce

The milestone is not "print some totals". It is **"do not present an incomplete month as a final one"**.
So every report carries three provenance fields and two verdict fields, and the verdict is the point:

| Field | Meaning |
|---|---|
| `report.ruleVersions` | The rule version(s) that produced the numbers. Empty when the stored row records none — reported as empty, never invented. |
| `report.dateCutoff` | The newest stored day actually included, or `null` when there is no stored day. It is **not** the requested date. |
| `report.population` | `{ employees, employeeUid, dayRows }` — exactly whose records the report covers. |
| `report.computationStatus` | The stored status, passed through unchanged. The report layer never re-judges a day or a month. |
| `report.isFinal` | Whether that status is a **conclusion** for this scope. |

`isFinal` is defined per scope, and the three definitions are deliberately different:

| Scope | Final when | Why |
|---|---|---|
| day | `calculated` **or** `no_data` | On a working day with an approved rule and no scan at all, "absent" is a **finding**, not a gap (DECISIONS.md E24). `insufficient_data`, `pending_policy` and `failed` are not conclusions. |
| month | `calculated` only | A month is `calculated` only when every day inside it was judged (E23). `partial`, `pending_policy` and `no_data` are therefore all **not** final. |
| academic year | `calculated` only, **and** the period is closed, **and** every started month is derived | A year is a rollup of months; it cannot be final while any started month is not. |

`not_derived` is this layer's own extra status: **no stored row at all**. It is never final, and the month
body is `null` rather than a month of zeros — a `0` would read as "this person attended nothing", which is
a much stronger and false claim (E26).

### 1.1 Limitations travel with the number

`report.caveats` carries the three known limitations as `{ code, detail }` so a consumer cannot display the
figure without them:

| Code | Raised when | Source |
|---|---|---|
| `HOLIDAY_CALENDAR_EMPTY` | the period has no approved holiday **and** an `expectedWorkingDays` figure was derived | `PROJECT_STATE.md` R8, `S2-D` |
| `NIGHT_SHIFT_LATENESS_WITHHELD` | any included day is an overnight shift | `P-03`, E12 |
| `APPROVER_IS_SESSION_LABEL` | a rule behind the numbers has `approvedBy` matching `owner:session…` | `D-E`, `PROJECT_STATE.md` R2 |

They are **derived, not assumed**: the holiday caveat is only raised after actually querying the holiday
calendar, the overnight caveat only from a stored `isOvernight`, and the approver caveat only while the
approver really is a session label. Recording the accountable person removes it automatically.

### 1.2 The academic year is a stated reporting convention
A Thai academic year runs **1 June (Y) – 31 May (Y+1)**. `:year` in the path is the **Gregorian year the
academic year starts**. This is a reporting period, not an attendance-policy value, so the response always
names the window it used in `report.period` (`from`, `to`, `academicYear`, `academicYearStartMonth`)
rather than leaving the reader to assume it.

Months that have **not started** are reported separately (`yearSummary.monthsNotYetStarted`) and are
excluded from the completeness verdict: a month that has not happened cannot be "missing data". Started
months with no stored row are listed in `yearSummary.monthsMissing` and do make the year not final.

## 2. Interfaces

### 1.3 `isFinal` and provenance are SEPARATE

A month can be `isFinal: true` and still carry an empty `ruleVersions`, `dateCutoff: null` and
`expectedWorkingDays: null`. The fixture seed row for 2026-03 is exactly that, and the frontend review
build shows it: `Calculated`, but `Rule version —`, `Date cutoff —`, `Days included 0` and
`Expected working days not derivable`.

That is not a contradiction. `isFinal` answers **"was the judgement complete?"**; the provenance fields
answer **"how traceable is it?"**. They are deliberately independent, and the traceability gap is reported
as an empty value rather than filled in with a plausible-looking guess.

### 2.1 Domain — `backend/src/domain/attendanceReport.js` (pure)

`REPORT_KIND`, `REPORT_STATUS`, `STATUS_SEVERITY`, `FINAL_STATUSES_BY_KIND`, `ACADEMIC_YEAR_START_MONTH`,
`REPORT_CAVEAT`, `isSessionLabelApprover`, `describeCaveat`, `isFinalStatus`, `verdictOf`,
`assertReportMonth`, `monthBoundsOf`, `academicYearPeriod`, `periodKeyOf`. No I/O, no database, no clock.
`verdictOf` takes the **worst** status (a documented severity order) and ignores anything unrecognised.

### 2.2 Service — `backend/src/services/attendanceReportService.js`

`dayReport` · `monthReport` · `academicYearReport`. **Read-only**: it never calculates a day, never
derives a month and never writes. Deriving stays behind the manager/admin-only monthly-summary route, so a
report can never change the data it describes.

Authorization runs on all three, and **before** the employee-existence check, so a caller outside the scope
gets `403` rather than an existence oracle (`REPORT_UNKNOWN_EMPLOYEE` / `404` is only reachable once the
scope allows the record).

### 2.3 API

| Method | Path |
|---|---|
| GET | `/api/v1/attendance/report/day/:employeeUid/:date` |
| GET | `/api/v1/attendance/report/month/:employeeUid/:year/:month` |
| GET | `/api/v1/attendance/report/academic-year/:employeeUid/:year` |

All three are in `docs/API_CONTRACT.md`, so `contract:smoke` exercises them (**30** paths, was 27).

## 3. Defects found during development (recorded, not hidden)

| # | Severity | Defect | Status |
|---|---|---|---|
| 1 | test-only | The test helper that populates March omitted two scans, so the month had one fewer judged day than the assertions claimed. It was found by reading the actual `dayCounts` output rather than by relaxing the assertion. | Fixed: the helper now seeds all six days, and the expectation is `calculated: 4 / no_data: 2` with the reason written down. |
| 2 | — | The academic-year total for `expectedWorkingDays` would have read `0` when a stored month could not derive it. | Guarded in the first implementation: the total is `null` unless **every** stored month could derive it, mirroring E25. |

## 4. QA evidence

| Check | Command | Result |
|---|---|---|
| Backend lint | `cd backend && npm run lint` | **PASS** |
| Slice 4 suite | `node --test tests/attendanceReport.test.js` | **PASS** 18/18 |
| Backend suite | `cd backend && npm test` | **PASS** — 398 tests, 388 pass, 0 fail, 10 skipped |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS** — 30 paths (was 27) |
| Frontend build (type-check + bundle) | `cd frontend && npm run build` | **PASS** |
| Frontend behaviour in review mode | `VITE_REVIEW_MODE=fixture npm run dev`, driven in a browser | **PASS** — 2026-07 (partial) renders `Not final — Partial.` before any figure with `2 day(s) could not be judged`; 2026-03 (calculated) renders the `Calculated` badge and no banner; 2026-10 renders `Not final — Not derived.` and "no figures to show" instead of zeros. No console errors, no failed requests. |

**Not verified here:** the MariaDB twin. R-02 adds no schema and no query to either repository, and it
reads only through the existing `dailyAttendance` / `monthlySummaries` / `attendanceRules` contracts, so
the existing `backend-mariadb` job is the verification for those columns. No real database was contacted.

## 5. Unresolved / out of scope

1. **`approvedBy` is still a session label** (`R2`). The report surfaces it as a caveat instead of hiding
   it, but naming the accountable person is still required before these values are used against a person.
2. **The holiday calendar is still empty** (`S2-D`), so `expectedWorkingDays` counts the working week only.
3. **Night-shift months are still `partial`** until `P-03` defines overnight lateness — and the report now
   says so explicitly instead of showing a `partial` month as final.
4. **The legacy `/attendance/monthly/:employeeUid/:year/:month` route stays** (it is in the published API
   contract), but the frontend monthly view now reads `/attendance/report/month/...`, so the UI shows the
   completeness verdict and can no longer present a `partial` month as final. The legacy client method is
   kept only because the route is still contracted and exercised by `contract:smoke`.
5. **The fixture seed month carries no provenance** (no rule version, no stored days). Reported honestly as
   an empty value; naming the rule behind a stored month is only possible once that month is derived.
6. **R-03 (exports) and R-04 (reconciliation snapshot)** remain, and R-03 must carry this same
   `computationStatus` / `isFinal` / `caveats` contract into whatever it exports.

## 6. Review checklist

- [ ] The `isFinal` rules accepted, including the deliberate asymmetry between a day-level `no_data`
      (final: it is an absence) and a month-level `no_data` (not final: it is missing data).
- [ ] `dateCutoff` = the newest **stored** day accepted (not the requested date).
- [ ] The academic year being **1 June – 31 May**, and being named in the response, accepted.
- [ ] `expectedWorkingDays: null` rather than `0` in the year rollup accepted.
- [ ] The read-only design accepted (deriving stays manager/admin-only, behind the monthly-summary route).
- [ ] The frontend monthly view reading the report endpoint accepted, including the provisional styling and
      the "never derived" state that shows no figures at all.
- [ ] The three `caveats` accepted as the mechanism that keeps R2 / R8 / P-03 visible in every report.
- [ ] Kept **Draft** until reviewed (PR [#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41), base `feat/agent-core-live-decisions`).

## 7. Next actions

| ID | Task | Note |
|---|---|---|
| — | ~~Decide the branch~~ **DONE**: `feat/slice4-attendance-reports` off the tip, Draft PR [#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41). | Kept Draft; nothing merged, nothing retargeted |
| R-02-FE | ~~Wire the frontend monthly view~~ **DONE** — the verdict is rendered before the figures | Follows this slice |
| R-03 | Export layer (XLSX, PDF, annual form), with server-enforced filters and export authorization | R-02; must carry this contract |
| R-04 | Reconciliation test against a frozen synthetic snapshot | R-02 |
