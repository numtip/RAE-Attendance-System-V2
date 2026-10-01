# API contract

Base path: `/api/v1`.

Legacy callers used `https://raeservice.mju.ac.th/api/...` and, in the same bundle, `/attendance/api/...`. Those prefixes are not part of V2.

## Implemented

| Method | Path | Status | Contract |
|---|---|---|---|
| GET | `/api/v1/health` | 200 | `{ success: true, data: { status: "healthy", service: "rae-attendance-v2", version }, message: "API is running" }` |

## Reserved for Release 1

These routes exist and return `501` with `error.code = NOT_IMPLEMENTED`.

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
