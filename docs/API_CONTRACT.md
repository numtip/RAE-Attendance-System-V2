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
| GET | `/api/v1/auth/sso/login` | 403 | `SSO_DISABLED` until the MJU callback is confirmed. |
| GET | `/api/v1/auth/sso/callback` | 403 | Same gate. Enabling the flag still returns `SSO_NOT_READY` and does not redirect. |
| GET | `/api/v1/auth/sso/me` | 403 | Same gate. |
| POST | `/api/v1/auth/sso/logout` | 403 | Same gate. |

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
