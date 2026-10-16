# API contract

Base path: `/api/v1`.

Legacy callers used `https://raeservice.mju.ac.th/api/...` and, in the same bundle, `/attendance/api/...`. Those prefixes are not part of V2.

## Implemented

Default `DATA_SOURCE=fixture`. The MariaDB adapter does not connect while ERROR 1932 stands.

| Method | Path | Status | Contract |
|---|---|---|---|
| GET | `/api/v1/health` | 200 | `{ success: true, data: { status: "healthy", service: "rae-attendance-v2", version }, message }` |
| POST | `/api/v1/auth/login` | 200 / 400 / 401 / 403 | Body `email`, `password`. Success `data` has `accessToken`, `refreshToken`, `employee`. |
| POST | `/api/v1/auth/refresh` | 200 / 401 | Body `refreshToken`. The presented token is revoked on success. |
| GET | `/api/v1/auth/me` | 200 / 401 | Bearer access token. Password hash is omitted. |
| POST | `/api/v1/auth/logout` | 200 / 401 | Bearer token plus body `refreshToken`. |
| GET | `/api/v1/employees` | 200 / 401 | Authenticated list. |
| GET | `/api/v1/employees/:employeeUid` | 200 / 404 | Profile without `passwordHash`. |
| GET | `/api/v1/employees/:employeeUid/attendance` | 200 / 403 / 404 | Own records, or any records for admin/manager. |
| GET | `/api/v1/attendance/daily/:date` | 200 / 403 | Admin or manager. |
| GET | `/api/v1/attendance/monthly/:employeeUid/:year/:month` | 200 / 403 / 404 | Own summary, or any summary for admin/manager. |
| GET | `/api/v1/leave` | 200 / 403 | Own rows unless `employeeUid` is allowed. |
| GET | `/api/v1/leave/balance/:employeeUid` | 200 / 403 / 404 | Query `year`. |
| GET | `/api/v1/leave/history/:employeeUid` | 200 / 403 / 404 | |
| GET | `/api/v1/attendance/daily-computed/:employeeUid/:date` | 200 / 401 / 403 | Slice 2. The stored computed day with its rule version, computation status and provenance. `null` data when the day has not been calculated. Own records, or any records within the caller's resolved scope. |
| GET | `/api/v1/attendance/daily-computed/:employeeUid` | 200 / 401 / 403 | Slice 2. Stored computed days for one employee. Query `from` and `to` are inclusive `YYYY-MM-DD`. |
| GET | `/api/v1/attendance/explain/:employeeUid/:date` | 200 / 400 / 401 / 403 | Slice 2. Recalculates WITHOUT storing, and reports why (`pending_policy` when no approved rule covers the date). Includes `stale` when the stored row disagrees with a fresh calculation. |
| POST | `/api/v1/attendance/recalculate` | 200 / 400 / 401 / 403 | Slice 2. Manager or admin only. Body `from`, `to`, optional `employeeUid` and `sourceSystem`. Deterministic and idempotent. With no `employeeUid` it only rebuilds employees that have scans in the range. |
| POST | `/api/v1/attendance/recalculate/:employeeUid` | 200 / 400 / 401 / 403 | Slice 2. As above, scoped to the path employee. An admin without an explicit authorization grant cannot recalculate another employee's record. |
| GET | `/api/v1/attendance/monthly-summary/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 | Slice 3. The stored month derived from the daily rows. `data` is `null` when the month was never derived — deliberately absent rather than a fabricated month of zeros. Carries `computationStatus`, `ruleVersions`, `expectedWorkingDays` (null = not derivable) and `dayCounts`. |
| GET | `/api/v1/attendance/monthly-summary/:employeeUid/:year` | 200 / 400 / 401 / 403 | Slice 3. Every stored month of a year, ordered by month. |
| GET | `/api/v1/attendance/monthly-summary-explain/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 | Slice 3. The stored month beside a fresh derivation, plus `stale` and `staleReasons`. Staleness compares the derived **values**, not timestamps, because a timestamp comparison is unreliable at millisecond resolution. |
| POST | `/api/v1/attendance/monthly-summary/recalculate/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 | Slice 3. Manager or admin only: this writes derived data. Deterministic and idempotent (one row per employee-month). |
| POST | `/api/v1/attendance/monthly-summary/recalculate` | 200 / 400 / 401 / 403 | Slice 3. Body `year` (required), optional `month` and `employeeUid`. Deriving a whole **year** across the organization requires a broad data scope; role alone is not enough. Months with no daily rows are reported, not written. |
| GET | `/api/v1/attendance/report/day/:employeeUid/:date` | 200 / 400 / 401 / 403 / 404 | R-02. Read-only. One stored employee-day plus the provenance the milestone requires: `report.ruleVersions`, `report.dateCutoff`, `report.population`, `report.computationStatus` and `report.isFinal`. `day` is `null` when the day was never calculated (status `not_derived`), never a fabricated zero day. `report.caveats` carries the limitations that travel with the number (empty holiday calendar, withheld overnight lateness, session-label approver). |
| GET | `/api/v1/attendance/report/month/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 / 404 | R-02. Read-only. The stored month, its days, and `report.isFinal` — `true` only when `computationStatus` is `calculated`. A `partial` / `pending_policy` / `no_data` / `not_derived` month is returned **as such** with `report.statusReasons` naming the hole, and `month.expectedWorkingDays` stays `null` when it could not be derived. |
| GET | `/api/v1/attendance/report/academic-year/:employeeUid/:year` | 200 / 400 / 401 / 403 / 404 | R-02. Read-only. The twelve months of a Thai academic year (`:year` is the Gregorian year the academic year **starts**, so 1 June `:year` to 31 May `:year + 1`). Every month is listed with its own status; months that have not started yet are reported separately and are excluded from the verdict. `report.isFinal` requires a closed period and every started month `calculated`. `yearSummary.totals.expectedWorkingDays` is `null` unless every stored month could derive it. |
| GET | `/api/v1/attendance/reconciliation/day/:employeeUid/:date` | 200 / 400 / 401 / 403 / 404 | R-04. Read-only **reconciliation snapshot**: the canonical stored day compared against the verified source records it was derived from. Reports `status` (`matched` / `mismatched` / `incomplete` / `blocked`), every `checks` entry with its `observed`/`expected`, `unresolvedExceptions`, `completeness`, `snapshotHash` and `pristine: true`. Reconciles against stored V2 records **only** — `realSourceVerified` is `false` with a `realSourceNote` explaining that no external FY source was integrated, so the snapshot does not verify the original HIP/MJU source data. It never writes. |
| GET | `/api/v1/attendance/reconciliation/month/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 / 404 | R-04. As above for a calendar month, adding period-level checks (employee count, daily-row coverage, month totals vs the summed daily rows, expected working days, report totals). A month with nothing to compare is `incomplete`, never `matched`. |
| GET | `/api/v1/attendance/reconciliation/fiscal-year/:employeeUid/:fiscalYear` | 200 / 400 / 401 / 403 / 404 | R-04. As above for a Thai government **fiscal year** (ปีงบประมาณ): `:fiscalYear` is the **Buddhist Era** year, running 1 October (BE−544) to 30 September (BE−543) — so `2569` is `2025-10-01`..`2026-09-30`. This is **NOT** the R-02 academic year (June–May); both the BE year and the Gregorian window are named in the response so the two cannot be confused. |
| GET | `/api/v1/attendance/export/day/:employeeUid/:date` | 200 / 400 / 401 / 403 / 404 | R-03. **Binary download**, not the JSON envelope: `application/pdf` or the XLSX type, with `Content-Disposition: attachment`, `Content-Length` and `Cache-Control: no-store, private`. Query `format` is **required** (`pdf` \| `xlsx`); anything else is `400 EXPORT_INVALID_FORMAT`. The file is a rendering of the R-02 day report, so it carries the same `computationStatus`, `isFinal`, `dateCutoff`, rule versions, population and caveats — and a `DRAFT / ข้อมูลยังไม่สมบูรณ์` watermark whenever the report is not final. |
| GET | `/api/v1/attendance/export/month/:employeeUid/:year/:month` | 200 / 400 / 401 / 403 / 404 | R-03. As above for the stored month, including the daily detail rows. A `partial` / `pending_policy` / `not_derived` month is exported **as a watermarked draft**, never as final figures. |
| GET | `/api/v1/attendance/export/academic-year/:employeeUid/:year` | 200 / 400 / 401 / 403 / 404 | R-03. As above for the academic year (1 June `:year` – 31 May `:year + 1`), with a month-by-month table and year totals. Exports are read-only and enforce the same scope as R-02: a cross-scope download is `403` with the JSON error envelope, never a file. |
| GET | `/api/v1/attendance/report/fiscal-year/:employeeUid/:fiscalYear` | 200 / 400 / 401 / 403 / 404 | R-05. Read-only **annual** report for a Thai government **fiscal year** (ปีงบประมาณ). `:fiscalYear` is the **Buddhist Era** year, 1 Oct (BE−544) – 30 Sep (BE−543), so `2569` is `2025-10-01`..`2026-09-30`. AGGREGATES the twelve R-02 monthly payloads; it derives nothing. Carries `computationStatus`, `isFinal`, `dateCutoff`, `ruleVersions`, `population` and the union of the monthly caveats. **All-or-null totals:** a metric total is `null` with a named reason whenever ANY contributing month is missing, never derived or unjudged — never `0` and never a partial sum presented as the annual figure. `monthCoverage` names which months contributed and which did not. The payload also names the period kind explicitly and reports `crossEmployeeOwnershipDetection`, which states whether a mid-year change of code holder could be evaluated (see the limitation in `docs/unified/14_SLICE7_ANNUAL_HR_REPORT.md`). |
| GET | `/api/v1/attendance/report/annual-academic/:employeeUid/:year` | 200 / 400 / 401 / 403 / 404 | R-05. The same annual report for the **academic** window (1 June `:year` – 31 May `:year + 1`). A **separate path** from `/attendance/report/academic-year/...` on purpose: R-02 owns that route and its contract is unchanged. The two windows are always explicitly distinguishable in the payload — never ambiguous, and a fiscal request never returns an academic window. |
| GET | `/api/v1/attendance/export/fiscal-year/:employeeUid/:fiscalYear` | 200 / 400 / 401 / 403 / 404 | R-05. Binary download of the fiscal annual report, reusing the R-03 export contract exactly: `format` is **required** (`pdf` \| `xlsx`), the response carries `Content-Disposition`, `Content-Length` and `Cache-Control: no-store, private`, and a failure arrives as the JSON envelope rather than a partial file. A non-final annual report renders with the R-03 **DRAFT** banner and watermark — the same mechanism, not a second one. |
| GET | `/api/v1/attendance/export/annual-academic/:employeeUid/:year` | 200 / 400 / 401 / 403 / 404 | R-05. As above for the annual academic window. |
| GET | `/api/v1/auth/sso/login` | 302 / 403 / 503 | Redirects to MJU authorization URL when `SSO_ENABLED=true`, `SSO_CALLBACK_CONFIRMED=true`, and config is complete. Otherwise `SSO_DISABLED` or `SSO_NOT_READY`. Default deploy: **403**. |
| GET | `/api/v1/auth/sso/callback` | 302 / 4xx | OAuth callback. Validates `state`, exchanges `code`, maps MJU user to `employees`, issues V2 tokens, redirects to `APP_URL/?sso=success`. Not callable against real MJU until registration is confirmed. |
| GET | `/api/v1/auth/sso/me` | 200 / 401 / 403 / 503 | Bearer access token (same envelope as `/auth/me`). Closed until SSO gates pass. |
| POST | `/api/v1/auth/sso/logout` | 200 / 401 | Bearer token plus body `refreshToken`. Closed until SSO gates pass. |

## Previously reserved

These routes existed as `501` placeholders in the bootstrap and are now the implemented set above, except SSO which stays closed.

Failures use `{ success: false, error: { code, message } }`.

| Method | Path | Legacy evidence | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/login` | `POST /api/auth/login` with `email`, `password` | Donor validator requires email and password of at least 6 characters. Success body carries `accessToken`, `refreshToken`, and `employee` under `data`. |
| POST | `/api/v1/auth/refresh` | `POST /api/auth/refresh` with `refreshToken` | Interceptor expects `data.accessToken` and `data.refreshToken`. |
| GET | `/api/v1/auth/me` | `GET /api/auth/me` | Bearer access token. |
| GET | `/api/v1/auth/sso/login` | Donor `GET /api/auth/sso/login`. Bundle navigates to `/attendance/api/auth/sso/login`. | V2 uses only the `/api/v1` path. |
| GET | `/api/v1/auth/sso/callback` | Donor callback route | Query contract with MJU is still to be confirmed during implementation. |
| GET | `/api/v1/auth/sso/me` | Bundle calls `/attendance/api/auth/sso/me` and expects `data.success` and `data.data` | |
| POST | `/api/v1/auth/sso/logout` | Bundle posts to `/attendance/api/auth/sso/logout` | |
| GET | `/api/v1/employees` | `GET /api/employees` | |
| GET | `/api/v1/employees/:employeeUid` | `GET /api/employees/:id` | Donor parameter name is `employeeUid`. |
| GET | `/api/v1/attendance/daily/:date` | `GET /api/attendance/daily/:date` | The bundle also calls `/attendance/api/attendance/daily/:date`. V2 serves one path. |
| GET | `/api/v1/attendance/monthly/:employeeUid/:year/:month` | `GET /api/attendance/monthly/:uid/:year/:month` | |
| GET | `/api/v1/leave` | `GET /api/leave` | Not mounted in the donor image. |
| GET | `/api/v1/leave/balance/:employeeUid` | `GET /api/leave/balance/:id` | |
| GET | `/api/v1/leave/history/:employeeUid` | `GET /api/leave/history/:id` | |

## Explicitly out of Release 1

Dashboard summary, `/reports/*`, admin leave remap/sync, files, CSV import, and facescan-daily import routes. They were called by the production bundle and are recorded in `LEGACY_COMPONENT_ASSESSMENT.md`. They are not registered in this bootstrap, so they return `404`.
