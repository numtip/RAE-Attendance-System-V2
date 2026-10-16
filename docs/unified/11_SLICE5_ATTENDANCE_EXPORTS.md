# 11 — Slice 5 (R-03): attendance report export (PDF / XLSX)

Status: **`SLICE5_READY_FOR_REVIEW`** — implementation complete, all gates green locally.
**No migration. Not merged. Nothing applied to any host.**

Builds on [`10_SLICE4_ATTENDANCE_REPORTS.md`](10_SLICE4_ATTENDANCE_REPORTS.md) (R-02, PR
[#41](https://github.com/numtip/RAE-Attendance-System-V2/pull/41)).

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-16 (Asia/Bangkok) |
| Branch | `feat/slice5-attendance-exports`, stacked on `feat/slice4-attendance-reports` (PR #41) |
| Worktree | **None.** Per `AGENTS.md`. Subagents worked in the same workspace with file-level ownership. |
| WIP / stashes | Untouched: the 18 pre-existing entries and **2** stashes. |
| Migration | **None.** R-03 is read-only. |
| Reference datum | **`G:\ProjectAI\attendance-report-generator` DOES NOT EXIST** (checked 2026-10-16). No FY2569 historical reconciliation evidence was reachable; see §6. |
| Redaction | No PII, secret or national ID in this document or in any R-03 file. Sample artifacts use fixture data only. |
| Labels | **VERIFIED** · **REPORTED** · **UNKNOWN** |

**Delivered:** backlog item **R-03** — export an individual attendance report as PDF or XLSX for the day,
month and academic-year periods R-02 supports, carrying R-02's completeness contract into the artifact and
watermarking anything that is not final.
**Not** delivered: R-04 (reconciliation snapshot) and R-05 (annual HR form).

## 1. The rule this slice exists to enforce

A file is easy to circulate and hard to recall, so the honesty rules of R-02 must survive being printed.
Therefore **the export layer derives nothing**:

* Report DATA comes only from `attendanceReportService` (`dayReport` / `monthReport` /
  `academicYearReport`) — the same service the JSON endpoints use. No total is recomputed, no status is
  re-judged, and no second query is made for report content. The single extra read is the employee display
  record (id, Thai name, department, position) needed to put a name on the document.
* `computationStatus`, `isFinal`, `dateCutoff`, `ruleVersions`, `population`, `generatedFrom`, `caveats` and
  `statusReasons` are all reproduced in every artifact.
* **When `report.isFinal === false` the artifact is a watermarked draft**, in both formats:
  * PDF: a 96 pt diagonal grey `DRAFT` on **every** page (verified on pages 1–3 of the academic-year
    report), plus a red-bordered banner spelling `DRAFT` + `ข้อมูลยังไม่สมบูรณ์` + the Thai note, placed
    *before* any figure; the page footer status line turns red.
  * XLSX: the DRAFT banner occupies a dedicated row directly under the sheet title, **and** every sheet's
    red centred print header carries it, so no printed page can lose the marker.

`expectedWorkingDays: null` renders as `ไม่สามารถคำนวณได้` — never `0`, matching DECISIONS.md E25. A
never-derived month exports with **no totals rows at all**, matching E26.

### 1.1 Authorization is inherited, not re-implemented

`exportService` validates `format`/`kind` (pure parameter checks, no data access), then calls the R-02
service, which enforces **scope before existence** (`assertCanReadEmployee`, then the employee lookup) and
the period bounds. Only after that resolves is the display name read. A 403/404/400 therefore propagates
from R-02 unchanged, and an export can never be a side channel around the report contract. Every failure
happens **before a byte is written**, so a refusal arrives as the JSON error envelope, never as a half-sent
PDF.

## 2. Interfaces

### 2.1 New backend files

| File | Lines | Purpose |
|---|---|---|
| `src/domain/attendanceReportPresentation.js` | 476 | Pure. All Thai / Buddhist-Era / Asia-Bangkok formatting, the status-reason translation table, `safeExportFileName`, and `buildExportModel` — the one canonical model both renderers consume. |
| `src/services/export/xlsxWriter.js` | 372 | Pure, **zero dependencies**. ZIP + OOXML writer over `node:zlib`. |
| `src/services/export/pdfRenderer.js` | 397 | pdfkit (A4, Sarabun). Thai-aware line wrapping, per-page watermark, `bufferPages` footers. |
| `src/services/exportService.js` | 163 | Orchestration, parameter validation, authorization ordering. |
| `src/controllers/exportController.js` | 51 | Binary response headers. Deliberately does NOT use the JSON `success()` envelope. |

### 2.2 API

| Method | Path |
|---|---|
| GET | `/api/v1/attendance/export/day/:employeeUid/:date?format=pdf\|xlsx` |
| GET | `/api/v1/attendance/export/month/:employeeUid/:year/:month?format=pdf\|xlsx` |
| GET | `/api/v1/attendance/export/academic-year/:employeeUid/:year?format=pdf\|xlsx` |

`format` is **required** — there is no default, because a default would silently pick an artifact for the
caller. All three are in `docs/API_CONTRACT.md` and exercised by `contract:smoke` (**33** paths, was 30).

Response headers: content type, `Content-Disposition: attachment; filename="…"`, `Content-Length`,
`Cache-Control: no-store, private`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`. An attendance
report is per-user data, so a shared proxy must never keep a copy.

### 2.3 Frontend

`AttendanceMonthlyView.vue` gains PDF/XLSX download controls; the R-02 verdict banner and all existing
fields are unchanged, and the banner still renders before the figures. The client sends the bearer token in
the `Authorization` header (**never** the URL), parses a non-OK JSON envelope into the existing `ApiError`,
treats a `200` carrying JSON as an error rather than saving it as a file, sanitises the
`Content-Disposition` filename (path components stripped, strict whitelist, length cap, ASCII fallback), and
always revokes the object URL. A non-final report shows a draft warning next to the controls.

**Review mode has no backend, so exports are disabled there with a one-line explanation. No PDF or XLSX is
fabricated in the fixture mock.** This is the same call the repo made for `agent/` lint (E20): honesty over
demo-ability.

## 3. Dependency decisions (recorded, because they were real choices)

| Decision | Why |
|---|---|
| **`exceljs` was evaluated and REJECTED.** The XLSX is hand-written over `node:zlib`. | `exceljs@4.4.0` adds ~186 packages, pulls deprecated `glob@7` / `fstream` / `uuid@8`, and carries an unresolved moderate advisory whose only npm "fix" is a breaking downgrade to `3.4.0`. The writer needed here is one sheet type and a fixed part set. |
| **`pdfkit@^0.20.2` is the only new dependency.** | `npm audit` is clean. `pdfkit` shapes Thai correctly out of the box, which is the hard requirement. |
| **Sarabun is bundled** (`src/assets/fonts/`, SIL OFL 1.1, licence + hashes in that folder's README). | A PDF cannot render Thai without an embedded font, and a server cannot borrow an OS font. `deploy/docker/backend/Dockerfile` already copies `backend/src`, so it ships with no Dockerfile change. A missing font throws `EXPORT_FONT_MISSING` rather than falling back to a font that renders Thai as empty boxes. |
| Thai content was re-encoded as Thai-free English on the print sheets. | Thai is already correct. Re-encoding would have been churn, not a fix. |

## 4. Verification (run by the orchestrator, independently of the code that produced the artifacts)

Artifacts were generated from the **fixture repositories** (synthetic data, no database, no host contact)
into a temp directory outside the repo, then verified with tools that share no code with the writer.

| Check | Tool (independent of the writer) | Result |
|---|---|---|
| Real XLSX opens | **Microsoft Excel via COM** | **PASS** — all artifacts open with no repair prompt; sheet names and Thai intact |
| Exact ZIP/OOXML structure | Python `zipfile`, `.NET [xml]` | **PASS** — 6 parts, valid deflate, `namelist()` clean |
| Cell values round-trip | Python `openpyxl` 3.1.5 | **PASS** — Thai preserved including sheet names |
| PDF text + visual | Python `pymupdf` (fitz) | **PASS** — see the table below |
| Values equal the R-02 JSON | scripted diff | **PASS — 0 failures** |

### 4.1 Exported values equal the R-02 JSON exactly

Every month total matched cell-for-cell in both a final and a partial month:

| Field | R-02 JSON | XLSX | |
|---|---|---|---|
| `totalWorkDays` | 5 | 5 | OK |
| `totalPresent` | 2 | 2 | OK |
| `totalLate` / `totalLateMinutes` | 1 / 15 | 1 / 15 | OK |
| `totalAbsent` | 2 | 2 | OK |
| `totalEarlyMinutes` | 60 | 60 | OK |
| `totalWorkHours` | 23.75 | 23.75 | OK |
| `expectedWorkingDays` | 22 | 22 | OK |
| `holidayDays` | 1 | 1 | OK |
| `expectedWorkingDays` (2027) | `null` | `ไม่สามารถคำนวณได้` | OK (never `0`) |
| never-derived month | `month: null` | **no totals rows emitted** | OK |

The PDF text layer contains the same numbers, and `2569` (Buddhist Era) is present in every artifact while
the **filename** stays Gregorian ASCII.

### 4.2 The honesty gate holds in both formats

| Artifact | `isFinal` | PDF DRAFT spans | XLSX DRAFT banner |
|---|---|---|---|
| month (calculated) | true | **0** | absent |
| month (partial) | **false** | 96 pt on p1 **and** p2 + 14 pt banner | row 2 + red print header |
| month (not derived) | **false** | 96 pt on p1 | row 2 + red print header |
| academic year (partial) | **false** | 96 pt on **p1, p2, p3** | row 2 + red print header on both sheets |

### 4.3 Layout and safety

* **Zero text overflow across all 9 generated pages**, all true A4 (595×842 pt). This was the main layout
  risk: Thai has no word spaces, so pdfkit's own breaker would push a sentence past the margin; the renderer
  measures with `widthOfString` and breaks at Thai cluster boundaries, and a single over-long token is
  hard-split.
* **Formula injection is dead.** Eight hostile values (`=1+1`, `=cmd|' /C calc'!A0`, `+1+1`, `-1+1`,
  `@SUM(A1:A2)`, `=HYPERLINK(…)`, `A&B<C>D"E'F`, Thai + `& < >`) were written into day notes and exported.
  The sheet XML contains **zero `<f>` elements** and no unescaped `&`/`<`; **real Excel reports
  `HasFormula=False`** and displays `=1+1` as text. This is structural, not a sanitiser: a cell is only
  emitted as a number when the JavaScript value really is a finite `number`, and everything else is an
  `inlineStr`, which Excel treats as literal.
* **Filename safety** is whitelist-based — the uid comes from a URL path segment and every character outside
  `[A-Za-z0-9]` is dropped, so separators, dots and quotes cannot survive.

## 5. QA gates

| Gate | Command | Result |
|---|---|---|
| Lint | `cd backend && npm run lint` | **PASS** |
| Export suites | `node --test tests/attendanceExport*.test.js` | **PASS — 36/36** |
| Full backend suite | `cd backend && npm test` | **PASS — 434 tests, 424 pass, 0 fail, 10 skipped** |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS — 33 paths** (validates the content type, non-empty body, `Content-Length` agreement, and the `%PDF` / `PK` magic bytes) |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS — 361 tracked files** |
| Frontend build | `cd frontend && npm run build` | **PASS** |
| MariaDB / CI | GitHub Actions on the Draft PR | see the PR checks |
| `npm audit` (backend) | `npm audit` | **0 vulnerabilities** |

`contract-smoke` had to learn a new contract: an export answers with a file, not the JSON envelope. It now
asserts the magic bytes and that `Content-Length` matches the real body length, and still requires the JSON
error envelope on a non-200 — which is what proves a refusal never writes a partial file.

## 6. Unresolved / out of scope

1. **The reference project does not exist.** `G:\ProjectAI\attendance-report-generator` is **MISSING**
   (VERIFIED 2026-10-16). No FY2569 historical reconciliation evidence could be read, so **no claim about
   real-source reconciliation is made anywhere in this slice.** Everything above was produced from synthetic
   fixtures. This is the open item for R-04's item 9.
2. **PDF Thai text extraction is not byte-exact.** Words containing `ำ` (U+0E33) can extract decomposed
   (`ทำงาน` → `ทำางาน`) because pdfkit applies GSUB and maps the reordered glyph back to both codepoints.
   Visual output is correct, and numbers and dates extract exactly. A pdfkit/fontkit shaping behaviour, not
   an export defect. It affects **text search and copy-paste**, not reading or printing.
3. **`approvedBy` is still a session label** (R2); exports surface it as a caveat rather than hiding it.
4. **The holiday calendar is still empty** (S2-D), so `expectedWorkingDays` counts the working week only, and
   the export raises `HOLIDAY_CALENDAR_EMPTY` with it.
5. **Night-shift months remain `partial`** (P-03) and therefore export as drafts. Correct behaviour, but it
   is the current reason a real month would carry a watermark.
6. **No daily/academic-year export control in the UI yet** — only the monthly view has download buttons.
   `AttendanceDailyView.vue` renders raw `AttendanceRecord[]`, not an R-02 report, so it was deliberately
   left alone rather than given a control that could not carry the contract.
7. **A blob-URL revoke is deferred ~60 s** after the click (per the download-race note in §4.3) instead of
   being released immediately.

## 7. Review checklist

- [ ] The read-only, derive-nothing design accepted (R-02 stays the single source of report data).
- [ ] The DRAFT watermark in **both** formats accepted as the mechanism that stops an incomplete month
      circulating as final.
- [ ] `format` being required, with no default, accepted.
- [ ] The `exceljs` rejection and the hand-written ZIP/OOXML writer accepted as the dependency posture.
- [ ] The bundled OFL font (with licence and hashes) accepted.
- [ ] Export endpoints answering with a file rather than the JSON envelope accepted, including
      `Cache-Control: no-store, private`.
- [ ] The known Thai-extraction limitation (§6.2) accepted as documented rather than worked around.

## 8. Next actions

| ID | Task | Note |
|---|---|---|
| R-04 | Read-only reconciliation snapshot (daily / month / **fiscal year Oct–Sep**) | Next; must NOT be confused with the R-02 academic year (Jun–May) |
| R-04-B | Resolve the missing `G:\ProjectAI\attendance-report-generator` reference, or formally record that FY2569 reconciliation cannot be verified against a real source | Blocks the "validate against historical evidence" half of R-04 |
| R-05 | Annual HR form (แบบรายงานประจำปี) | Reuses this renderer |
| R-03-FE | Export controls for the day and academic-year views | Needs those views to read the report endpoint first |
