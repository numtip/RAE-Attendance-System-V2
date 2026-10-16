# 14 — Slice 7 (R-05): annual HR report

Status: **`SLICE7_READY_FOR_REVIEW`** — implementation complete, all gates green locally.
**No migration. Not merged. Nothing applied to any host.**

Builds on [`13_REFERENCE_PROJECT_AUDIT.md`](13_REFERENCE_PROJECT_AUDIT.md) and reuses R-02 (facts) and R-03
(exports).

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-16 (Asia/Bangkok) |
| Branch | `feat/slice7-annual-hr-report`, stacked on `feat/identity-hardening` (PR #45) |
| Worktree | **None.** Per `AGENTS.md`. Three parallel tracks shared the workspace with exclusive file ownership. |
| WIP / stashes | Untouched: the 4 pre-existing modified files and **2** stashes. |
| Migration | **None.** R-05 adds no schema and no query. |
| Data | **Synthetic fixtures only.** Nothing was copied from the private reference project. |
| Labels | **VERIFIED** · **REPORTED** · **UNKNOWN** |

**Delivered:** backlog item **R-05** — an annual HR report for a Thai fiscal year (and, separately, the
academic window), derived from the twelve R-02 monthly payloads, exportable through the R-03 renderer.

## 1. The reference audit — what the annual precedent actually is

`G:\ProjectAI\attendance-report-generator` (private, read-only) was audited for the official annual form.

**VERIFIED: there is no annual FORM template.** The reference holds:

| Location | What it actually contains |
|---|---|
| `output/fy2569/` | annual **close reports**: `annual_reconciliation_report.md`, `annual_validation_summary.md`, `ownership_timeline.md`, `final_qa_report.md`, `anomaly_report.md`, `employee_reconciliation_report.md` + JSON |
| `output/fy2569/annual_employee_reports/` | **34 per-employee annual documents** (`*.docx` + `*.pdf`) + `qa_report.md`, `reconciliation.csv` |
| `templates/` | **two MONTHLY templates only** (`attendance_summary_template.xlsx`, `monthly_attendance_form_template.xlsx`) |
| `docs/total2026-3.xlsx` | an annual **ledger**, not a template |

So R-05 **builds** the annual form; it did not copy one. No file, template, workbook, name or personnel value
entered this repo.

### 1.1 Two donor precedents, verified in the reference's own text

Both come from one sentence in the reference's `site/index.html` and are corroborated by its own close reports:

> *"สมุดรายปีคือ `docs/total2026-3.xlsx` เดือนที่รหัสเปลี่ยนคนไม่ถูกบวกรวมกัน ช่องที่ยังไม่มี source ไม่ถูกใส่เป็น 0"*

| # | Precedent | Corroboration | How R-05 honours it |
|---|---|---|---|
| 1 | **Months where a code changed owner are not summed together** | `output/fy2569/ownership_timeline.md` — 17 month-rows across four codes marked `excluded_other_person` | V2 keys attendance on `employee_uid` (E14), so two holders are two employees and a merge is **impossible by construction**; a mid-year hand-over yields two coverage-incomplete reports each with a `null` annual total — the same outcome. See §4.2. |
| 2 | **A field with no source is NOT filled with 0** | `anomaly_report.md`: *"stay blank. They were not filled with 0"*; `final_qa_report.md`: *"blank totals only for … missing scans"* | **All-or-null totals** — §2.2. |

## 2. The rule this slice exists to enforce

### 2.1 It aggregates; it derives nothing

Every monthly number comes from `attendanceReportService` (R-02). The annual layer sums what R-02 returned and
never recomputes a day, a month total, or a status. `computationStatus`, `isFinal`, `dateCutoff`,
`ruleVersions`, `population` and the **union** of the monthly `caveats` all travel into the annual payload.

The annual verdict follows R-04's discipline: **worst-of across the twelve months**, and a year with nothing to
compare is `incomplete` — never final.

### 2.2 All-or-null totals (the core requirement)

A metric's annual total is computed **only** if every contributing month supplied a value. If **any** month is
missing, never derived, or unjudged, the total for the affected metric is **`null` with a recorded reason** —
never `0`, and never a partial sum presented as the annual figure.

Verified independently on the generated artifacts:

| Scenario | `monthCoverage` | `totals` |
|---|---|---|
| `fiscal-complete` (all 12 contributed) | `complete: true`, `monthsExcluded: []` | real values — `totalWorkDays 306`, `totalPresent 186`, `totalLate 12`, `totalWorkHours 624` |
| `fiscal-missing` (1 month excluded) | `complete: false`, `monthsExcluded: [{key: '2025-04', reason: 'month_not_derived'}]` | **every total is `null`** |

This is E25's `expectedWorkingDays` rule applied to the whole year, and it is precedent 2 above.

### 2.3 Fiscal year vs academic year are never ambiguous

| Window | Period | Path |
|---|---|---|
| Thai government **fiscal** year `Y` (BE) | 1 Oct (Y−544) – 30 Sep (Y−543) | `/attendance/report/fiscal-year/:employeeUid/:fiscalYear` |
| **Academic** year | 1 Jun `:year` – 31 May `:year + 1` | `/attendance/report/annual-academic/:employeeUid/:year` |

Reuses `fiscalYearPeriod` and `academicYearPeriod`; it does not re-implement either. The payload names the
period kind explicitly, so a fiscal request can never return an academic window (a test asserts both the
difference and the explicit kind).

**Why a separate `annual-academic` path:** R-02 already owns `/attendance/report/academic-year/:year` and its
contract is published. Reusing that path for a different payload shape would have changed a published
contract; adding a distinct path does not.

### 2.4 Non-final renders as a draft, through the same mechanism

A non-final annual report renders with the **R-03 DRAFT banner and 96 pt watermark** by reusing the existing
renderer and presentation module. There is **no second watermark implementation** and the shared module was
not edited.

## 3. Interfaces

### 3.1 New files

| File | Lines | Purpose |
|---|---|---|
| `backend/src/domain/annualAttendanceReport.js` | 302 | Pure: periods, aggregation, all-or-null totals, verdict, coverage. |
| `backend/src/services/annualReportService.js` | 549 | Reads the twelve R-02 payloads, builds the annual report, renders via R-03. |
| `backend/src/controllers/annualReportController.js` | 79 | JSON + binary responses. |
| `backend/tests/annualReport.test.js` | 845 | 18 tests. |
| `backend/tests/fixtures/annualSyntheticFacts.js` | 167 | Synthetic scenarios, test-only. |

`backend/src/api/v1/index.js` gains **18 lines** (routes only).

### 3.2 API

| Method | Path |
|---|---|
| GET | `/api/v1/attendance/report/fiscal-year/:employeeUid/:fiscalYear` |
| GET | `/api/v1/attendance/report/annual-academic/:employeeUid/:year` |
| GET | `/api/v1/attendance/export/fiscal-year/:employeeUid/:fiscalYear?format=pdf\|xlsx` |
| GET | `/api/v1/attendance/export/annual-academic/:employeeUid/:year?format=pdf\|xlsx` |

All four are in `docs/API_CONTRACT.md` and exercised by `contract:smoke` (**40** paths, was 36). `format` is
**required** with no default, exactly as R-03. Authorization reuses `assertCanReadEmployee` — scope before
existence, before any read.

## 4. Defects and limitations found during development (recorded, not hidden)

### 4.1 Defects in the work itself

| # | Kind | Defect | Fix |
|---|---|---|---|
| 1 | test-only | An assertion that a fiscal response contains no `'2025-06-01'` "academic" substring **failed** — because FY2568 legitimately *contains* June 2025 as one of its twelve months. The assertion was wrong, not the code. | Assert the fiscal month list explicitly (Oct..Sep) and the absence of an academic period kind. |
| 2 | test-only | Expected the export filename to carry `2025-10-2026-09`; the correct slug is `2024-10-2025-09` because FY2568 starts in 2024. | Corrected the expectation; the code was right. |
| 3 | hygiene | Dead code (`annualMonthKey`, `messageFor`, unused exports) left after refactoring. | Removed; lint and the 18 tests re-run after each trim. |

### 4.2 An honest limitation: cross-employee ownership change is not detectable

Precedent 1 says a code's change of holder must not merge two people into one annual figure. R-05 **cannot
detect that condition**, and says so in the payload rather than pretending:

```json
"crossEmployeeOwnershipDetection": { "evaluated": false, "reason": "no repository method lists the other holders..." }
```

Why: V2 keys attendance on `employee_uid`, and both repository twins expose only per-employee reads
(`listByEmployeeUid`, `findEffectiveOn`). There is no "who else holds this code" lookup. The **safety property
still holds** — two holders are two `employee_uid`s, so a merge is impossible by construction, and a mid-year
hand-over produces two coverage-incomplete reports each with a `null` annual total, which is precedent 1's
outcome — but the *positive detection* is absent. Closing it needs a new cross-employee code-lookup method
plus the same owner confirmation `R-04-F` needs. Recorded as **R-05b**.

R-05 *does* expose `ownership.employeeCodeByMonth` (from `employee_assignment`), so a code change **within one
employee** is visible.

### 4.3 Test-only non-vacuity

The PII test asserts the serialized payload is substantive (>500 chars, contains `computationStatus` and the
uid) **and** carries a positive control — a planted national id and a planted `passwordHash` must be caught by
the scanner. An empty or mis-rooted scan therefore cannot pass. This is the trap this repo has been bitten by
twice.

## 5. Verification

### 5.1 Gates

| Gate | Command | Result |
|---|---|---|
| Lint | `cd backend && npm run lint` | **PASS** |
| Annual suite | `node --test tests/annualReport.test.js` | **PASS — 18/18** |
| Full backend suite | `cd backend && npm test` | **PASS — 526 tests, 516 pass, 0 fail, 10 skipped** (was 508) |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS — 40 paths** (was 36) |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS — 390 files** |
| Frontend build | `cd frontend && npm run build` | **PASS** |
| MariaDB / CI | GitHub Actions on the Draft PR | see the PR checks |

### 5.2 Independent artifact verification (orchestrator, not the implementation's own script)

Six scenarios generated into `%TEMP%\rae-annual` (outside the repo) and checked with `pymupdf`:

| Scenario | `isFinal` | Pages | A4 | DRAFT watermark | Gate |
|---|---|---|---|---|---|
| fiscal-complete | true | 2 | yes | **absent** | OK |
| fiscal-missing | false | 2 | yes | **present** | OK |
| fiscal-unjudged | false | 2 | yes | **present** | OK |
| academic-complete | false | 2 | yes | **present** | OK |
| ownership-first | false | 2 | yes | **present** | OK |
| ownership-second | false | 2 | yes | **present** | OK |

**Watermark present iff not final; 0 gate failures.** The implementation separately reported 26/26 checks
including byte-identical regeneration across two runs and a 7-part OOXML package via `Expand-Archive`.

## 6. Unresolved / out of scope

1. **`R-05b`** — cross-employee ownership change is not positively detectable (§4.2).
2. **MariaDB twin not exercised locally.** R-05 adds no query, but `ownershipOf` compares
   `effectiveFrom`/`effectiveTo` as `'YYYY-MM-DD'` strings; both twins currently return ISO strings, so this is
   correct today and would break if a twin ever returned a `Date` (standing rules 1 and 6). `backend-mariadb`
   CI is the real-twin check.
3. **Holiday calendar still empty** (S2-D), so `expectedWorkingDays` counts the working week only. The annual
   payload propagates `HOLIDAY_CALENDAR_EMPTY` from the monthly caveats rather than hiding it.
4. **No annual report in the frontend.** Not required by this slice.
5. **`approvedBy` remains a session label** (R2).

## 7. Review checklist

- [ ] All-or-null totals accepted as the annual rule (§2.2), including that a single missing month nulls the
      affected metric rather than shrinking it
- [ ] The fiscal (Oct–Sep) and academic (Jun–May) windows being explicitly distinguishable, with a separate
      path for the annual academic window rather than a change to R-02's published contract, accepted
- [ ] The reuse of the R-03 renderer and watermark accepted (no second implementation)
- [ ] The ownership-detection limitation (§4.2) accepted as **stated rather than engineered around**, with
      `R-05b` tracked
- [ ] The reference audit's conclusion accepted: there is **no** annual form template, so R-05 builds one

## 8. Next actions

| ID | Task | Note |
|---|---|---|
| **R-05b** | Add a cross-employee employee-code lookup so a change of holder is positively detected | Needs a repository method + owner confirmation |
| R-03-FE | Export controls for the day and academic-year views | Existing gap |
| — | Frontend surface for the annual report | Follows this slice |
