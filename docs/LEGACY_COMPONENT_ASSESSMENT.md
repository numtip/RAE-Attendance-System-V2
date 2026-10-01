# Legacy component assessment

Donors were read only. The legacy project is not imported as a tree.

| Component | Decision | Why |
|---|---|---|
| API namespace `/api/v1/` | REWRITE | Legacy mixed `/api/` and `/attendance/api/`. The production bundle calls both. |
| Health `GET /api/health` envelope `{ success, data.status, message }` | REUSE | Verified in the December 2025 image and matched by the legacy health checker. V2 exposes it at `/api/v1/health`. |
| Email/password login, refresh token, `GET /auth/me` | REWRITE | The image validates `email` and `password` and returns `accessToken` plus `refreshToken` inside `data`. The implementation is rewritten against `employees.password_hash`, `refresh_tokens`, and `auth_logs`. The legacy JWT secret is not copied. |
| MJU SSO redirect, callback, me, logout | REFERENCE_ONLY | The image has `GET /api/auth/sso/login`, `/callback`, `/me` and `POST /logout`. The production bundle navigates to `/attendance/api/auth/sso/*`, which nginx serves as HTML. V2 keeps the OAuth shape and changes the path. See `SSO_REUSE_PLAN.md`. |
| DB access layer | REWRITE | A new repository layer will use the existing tables. The legacy pool setup is not copied. |
| `daily_attendance` / `monthly_summary` meaning | REUSE | Column enums and aggregates are verified from `information_schema`. |
| Attendance calculator and leave aggregator source | REFERENCE_ONLY | Present in the donor image. Not copied until a route needs a specific function and that function is reviewed. |
| Employee list and lookup by `employee_uid` | REWRITE | Image routes are `GET /api/employees` and `GET /api/employees/:employeeUid`. V2 keeps those resources under `/api/v1/employees`. |
| Leave balance and history | REWRITE | Image routes match `/leave/balance/:employeeUid` and `/leave/history/:employeeUid`. |
| Leave list `GET /api/leave` | REWRITE | The production SPA calls it. The donor image does not mount `GET /leave`. |
| Dashboard, plural `/api/reports/*`, admin CSV, files, facescan-daily | RETIRE from Release 1 | The SPA calls them. They are outside Release 1 and their handler source is not in the donor image. |
| `sync/*` and hip integration | RETIRE | No current view calls the sync helpers. No hip path was found in the production bundle. |
| Canva proxy and `canva_tokens` | RETIRE | Separate product surface. Token columns must not be exported. |
| PM2 ecosystem, legacy nginx, Docker Compose service `attendance-api` | RETIRE | V2 is not started through those mechanisms. |
| Legacy frontend `baseURL` `https://raeservice.mju.ac.th/api` | RETIRE | V2 client will call `/api/v1` only. |
| Hard-coded fallback secrets in the donor config | RETIRE | V2 config has no fallback secret. Missing `JWT_SECRET` stays empty until Release 1 auth is implemented. |

Do not copy `node_modules`, `.env`, SQL backups, or `service-account-key.json` from the donor tree or image.
