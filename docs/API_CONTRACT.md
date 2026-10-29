# API contract

Base path: `/api/v1`.

Legacy callers used `https://raeservice.mju.ac.th/api/...` and, in the same bundle, `/attendance/api/...`. Those prefixes are not part of V2.

## Implemented

Default `DATA_SOURCE=fixture`. The MariaDB adapter does not connect while ERROR 1932 stands.

| Method | Path | Status | Contract |
|---|---|---|---|
| GET | `/api/v1/health` | 200 | `{ success: true, data: { status: "healthy", service: "rae-attendance-v2", version }, message }` |
| GET | `/api/v1/ready` | 200 / 503 | Readiness gate. `data` is `{ status: "ready", checks: { config, database } }`. `503 CONFIG_INVALID` lists error codes only; `503 DB_UNAVAILABLE` when configured but unreachable. Never returns a host, port, credential or database name. |
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
| GET | `/api/v1/auth/sso/login` | 302 / 403 / 503 | Redirects to MJU authorization URL when `SSO_ENABLED=true`, `SSO_CALLBACK_CONFIRMED=true`, and config is complete. Otherwise `SSO_DISABLED` or `SSO_NOT_READY`. Default deploy: **403**. |
| GET | `/api/v1/auth/sso/callback` | 302 / 4xx | OAuth callback. Validates `state`, exchanges `code`, maps the MJU profile to `employees` and **mints V2 tokens server-side that the browser never receives** (the controller only redirects; the handoff is unspecified — see `SSO_ACTIVATION_RUNBOOK.md`). Refused with `503 SSO_SUBJECT_CONTRACT_UNCONFIRMED` while `SSO_SUBJECT_CONTRACT_CONFIRMED=false`, so it cannot authenticate anyone against the live provider yet. |
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

## Personal report (Release 1)

Added by PR #50. Both routes are authenticated, read-only, and scoped to the caller's own record: a different `employeeUid`, or any `employeeId`, query parameter returns `403 FORBIDDEN`.

| Method | Path | Status | Contract |
|---|---|---|---|
| GET | `/api/v1/reports/personal` | 200 / 400 / 401 / 403 / 404 | Query `year` (2000–2100) and `month` (1–12), both required. Returns `data` with `employeeUid`, `employeeId`, `employeeName`, `department`, `position`, `year`, `month`, `buddhistYear`, `periodStart`, `periodEnd`, `periodLabel`, `empty`, `hasMonthlySummary`, `present`, `late`, `absent`, `leaveDaysOnSummary`, `workDays`, `lateMinutes`, `scans[]`, `leaveRows[]`, `remainingLeaveDays`, `source`, `exclusions`. An invalid or missing period returns `400 VALIDATION_ERROR`. |
| GET | `/api/v1/reports/personal/export` | 200 / 400 / 401 / 403 | Query `year`, `month`, and `format` (`pdf` or `xlsx`; anything else returns `400 EXPORT_INVALID_FORMAT`). Returns a binary download with `Content-Type` `application/pdf` or the XLSX media type and `Cache-Control: no-store` — **not** the JSON envelope. |

These two paths are deliberately absent from the `## Implemented` table above, because `scripts/contract-smoke.mjs` materializes table paths without query parameters and asserts a JSON envelope: the personal report requires `year`/`month`, and the export returns binary. Covering them needs a matching change to that script (follow-up, not done here).

## Explicitly out of Release 1

Dashboard summary, admin leave remap/sync, files, CSV import, and facescan-daily import routes. They were called by the production bundle and are recorded in `LEGACY_COMPONENT_ASSESSMENT.md`. They are not registered in this bootstrap, so they return `404`.
